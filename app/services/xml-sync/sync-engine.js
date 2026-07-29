// sync-engine.js
// Orquesta el proceso completo de sincronización: descarga el XML,
// normaliza, agrupa y crea/actualiza productos y variantes en Shopify.

import { adminGraphql, logger } from '../config.js';
import { sendProgress } from '../progress.js';
import { normalizeString } from '../../../utils/normalize-utils.js';
import { parseXmlItems } from './xml-parser.js';
import { buildCacheKey, normalizeFeedItem, groupByModelKey, isSyncableItem } from './feed-normalizer.js';
import { buildShopifyProductObject, convertVariantForShopify, sanitizeVariantForGraphQL, findVariant, variantNeedsUpdate, isDuplicateVariant, normalizeOptions, buildOptionsKeyFromSelectedOptions, buildOptionsKeyFromOptionValues } from './product-builder.js';
import { buildImageMapByMatching, getProductMediaWithRetry, getImageDimensions, isImageSmall, extractBaseName } from '../media-utils.js';
import { findExistingProduct, createShopifyProduct, updateShopifyProduct, getAllProductVariants, setProductMetafields, ensureProductMetafieldDefinitions, syncProductOptions } from '../shopify-api.js';
import { resetCancelFlag, wasCancelled } from '../../routes/api.sync-cancel.js';
import {
  GET_PUBLICATIONS,
  GET_PRODUCT_MEDIA,
  GET_PRODUCTS_BY_TAG,
  PRODUCT_CREATE_MEDIA,
  PRODUCT_DELETE,
  PUBLISH_PRODUCT,
  VARIANTS_CREATE,
  VARIANTS_UPDATE,
} from '../../shopify/queries';
import { resolveModels } from '../ai/model-resolver.js';
import { ensureDescription } from '../ai/description-generator.js';
import { freezeLiveResolutions } from '../ai/model-identity.js';

// Tag con el que la app marca todos los productos que crea. Se usa en la
// reconciliación final para acotar el borrado de huérfanos exclusivamente a
// los productos gestionados por esta sincronización, sin tocar nunca los que
// se hayan añadido manualmente a la tienda.
const MANAGED_PRODUCT_TAG = 'cosladafon';

// Estado de progreso por grupo (variantes totales/procesadas/con error).
const groupsState = {};

const VARIANTS_DELETE = `#graphql
  mutation productVariantsBulkDelete($productId: ID!, $variantsIds: [ID!]!) {
    productVariantsBulkDelete(productId: $productId, variantsIds: $variantsIds) {
      product { id title }
      userErrors { field message }
    }
  }
`;

// Sincroniza las variantes de un producto existente en Shopify con las del feed:
// sube imágenes, elimina placeholders y variantes obsoletas, crea o actualiza
// las variantes restantes en bulk.
export async function syncExistingProduct(admin, existing, productObj, groupId = null) {
  logger.section(`🔄 Sincronizando: ${existing.id} — ${productObj.title}`);
  let created = 0;
  let updated = 0;

  // Ordenar variantes por capacidad ascendente
  if (productObj?.variants?.length > 1) {
    const parseCapacityValue = (variant) => {
      const capObj = variant.optionValues?.find(ov => ov.optionName.toLowerCase() === 'capacidad');
      if (!capObj?.name) return 0;
      const text = String(capObj.name).toUpperCase().trim();
      const num = parseFloat(text.replace(/[^0-9.]/g, '')) || 0;
      return text.includes('TB') ? num * 1024 : num;
    };
    productObj.variants.sort((a, b) => parseCapacityValue(a) - parseCapacityValue(b));
  }

  sendProgress({ type: "variants-sync-start", productId: existing.id, groupId });

  let imageMap = {};
  let uploadedMediaNodes = [];

  // ── CORRECCIÓN BUG #4 ── Evitar duplicación de imágenes en cada sync.
  //
  // Problema original: se subían todas las imágenes del productObj en cada
  // ejecución del sync (con PRODUCT_CREATE_MEDIA) sin comprobar si ya existían
  // en el producto de Shopify. Esto provocaba que, con cada sync, el producto
  // acumulara copias duplicadas de las mismas fotos.
  //
  // Solución: antes de subir, obtener las URLs ya presentes en el producto y
  // filtrar para subir solo las imágenes cuyo baseName no coincida con ninguna
  // imagen existente. Se usa la misma lógica de normalización de extractBaseName
  // que emplea buildImageMapByMatching para garantizar consistencia.
  if (productObj.images?.length) {
    try {
      // Obtener las imágenes que ya tiene el producto en Shopify
      const existingMediaRes = await adminGraphql(admin, GET_PRODUCT_MEDIA, { id: existing.id });
      const existingMediaData = await existingMediaRes.json();
      const existingMediaNodes = existingMediaData?.data?.product?.media?.nodes || [];
      const existingUrls = new Set(
        existingMediaNodes
          .map(n => n?.preview?.image?.url)
          .filter(Boolean)
          .map(url => extractBaseName(url.split('?')[0]).replace(/_\d{10,}$/, '').toLowerCase())
      );

      // Solo subir imágenes cuyo baseName no esté ya en el producto
      const newImages = productObj.images.filter(img => {
        const base = extractBaseName(img.originalSrc).replace(/\+/g, '_').toLowerCase();
        return !existingUrls.has(base);
      });

      if (newImages.length > 0) {
        const media = newImages.map((img, i) => ({
          mediaContentType: "IMAGE",
          originalSource: img.originalSrc,
          alt: `${productObj.title} - ${i + 1}`
        }));

        await adminGraphql(admin, PRODUCT_CREATE_MEDIA, { media, product: { id: existing.id } });
        sendProgress({ type: "product_media_uploaded", productId: existing.id, groupId, count: media.length });

        // ── CORRECCIÓN BUG #8 ── El expectedCount debe ser el total de imágenes
        // del producto tras la subida, no solo las recién subidas.
        const expectedTotal = existingMediaNodes.length + media.length;
        const allMediaNodes = await getProductMediaWithRetry(admin, existing.id, 10, 2000, expectedTotal);
        sendProgress({ type: "product_media_added", productId: existing.id, groupId });

        uploadedMediaNodes = allMediaNodes;
      } else {
        logger.info(`ℹ️ [Media] Todas las imágenes ya existen en el producto ${existing.id}. No se suben duplicados.`);
        uploadedMediaNodes = existingMediaNodes;
      }

      imageMap = buildImageMapByMatching(productObj, uploadedMediaNodes);
    } catch (err) {
      logger.warn(`⚠️ Error uploading media for product ${existing.id}:`, err);
      if (err.body?.errors) {
        logger.warn(`⚠️ Error uploading media for product ${existing.id}:`, err.body.errors);
        return ({ errors: err.body?.errors }, { status: 500 });
      }
    }
  }

  const variantsToUpdate = [];
  const variantsToCreate = [];

  // getAllProductVariants devuelve ahora { variants, options }, obteniendo
  // las opciones reales del producto directamente desde Shopify en la misma
  // llamada. Esto elimina la dependencia de existing.options (que venía de
  // PRODUCT_SEARCH y podía contener la opción genérica "Title" si el producto
  // quedó a medias en una sync anterior).
  const { variants: productVariants, options: currentOptions } = await getAllProductVariants(admin, existing.id);

  // Sincronizar opciones usando los datos frescos de Shopify, no los de
  // PRODUCT_SEARCH que pueden estar desactualizados.
  if (currentOptions?.length && productObj.productOptions?.length) {
    await syncProductOptions(admin, existing.id, currentOptions, productObj.productOptions);
  }

  // ── Gestión de la placeholder de Shopify ────────────────────────────────
  // Cuando Shopify crea un producto con productCreate, genera automáticamente
  // una variante vacía (sin SKU, sin precio, sin opciones) llamada placeholder.
  // No se puede evitar en la mutación de creación.
  //
  // Estrategia:
  //   1. Detectar la placeholder (única variante sin SKU y sin barcode).
  //   2. Excluirla de variantsToDelete para que no se intente borrar.
  //   3. Si findVariant la devuelve como match de una variante del feed,
  //      ignorar ese match y forzar que la variante vaya a variantsToCreate.
  //      Shopify elimina la placeholder automáticamente en cuanto se crea
  //      la primera variante real con productVariantsBulkCreate.
  //
  // IMPORTANTE: nunca enviar la placeholder a variantsToUpdate. Shopify
  // rechaza productVariantsBulkUpdate sobre la placeholder con el error
  // "Product variant does not exist".
  // ─────────────────────────────────────────────────────────────────────────

  logger.info(`🔍 [syncExistingProduct] productId=${existing.id} → ${productVariants.length} variantes existentes en Shopify`);

  // Detectar la variante "Title" (placeholder de Shopify).
  // Shopify crea esta variante automáticamente con productCreate. Puede tener
  // dos formas según el estado del producto:
  //   A) Placeholder limpia: sin SKU, sin barcode, selectedOptions = [{name:"Title", value:"Default Title"}]
  //   B) Placeholder con SKU: ocurre cuando una sync anterior asignó un SKU a
  //      esta variante mediante VARIANTS_UPDATE antes de que se crearan las
  //      opciones reales. Tiene SKU pero selectedOptions sigue siendo Title.
  //
  // En ambos casos hay que tratarla igual: es una variante de Shopify que
  // ocupa el slot y que debe ser reemplazada por las variantes reales del feed.
  // La estrategia es excluirla del delete y de findVariant, y dejar que
  // REMOVE_STANDALONE_VARIANT en VARIANTS_CREATE la elimine automáticamente
  // al crear la primera variante real.
  const isTitleVariant = (v) => {
    const opts = v.selectedOptions || [];
    return opts.length === 1 &&
      opts[0].name?.trim().toLowerCase() === 'title' &&
      opts[0].value?.trim().toLowerCase() === 'default title';
  };

  // Enriquecer cada variante de Shopify con sus claves normalizadas e imagen
  productVariants.forEach(v => {
    v.normalizedSku = normalizeString(v.sku);
    v.normalizedBarcode = normalizeString(v.barcode);
    v.optionsKey = buildOptionsKeyFromSelectedOptions(v.selectedOptions || []);
    v.normalizedOptions = normalizeOptions(v.selectedOptions);

    logger.detail(`Variante ID: ${v.id} | Price: ${v.price} | SKU: ${v.sku || 'N/A'} | Barcode: ${v.barcode || 'N/A'} | Opciones: ${v.selectedOptions?.map(so => `${so.name}:${so.value}`).join(", ")}`);

    const imgUrl = v?.image?.url || null;
    if (imgUrl) {
      const base = extractBaseName(imgUrl);
      const foundMedia = uploadedMediaNodes.find(node =>
        node?.preview?.image?.url?.includes(base)
      );
      v.currentMediaId = foundMedia?.id || null;
    } else {
      v.currentMediaId = null;
    }
  });

  // SKUs activos en el feed para detectar variantes obsoletas.
  // Solo se consideran activos los SKUs de variantes con stock disponible;
  // los out_of_stock ya han sido filtrados en normalizeFeedItem, así que
  // este Set solo contendrá SKUs de variantes que deben mantenerse.
  const activeSkusInFeed = new Set(
    productObj.variants.map(v => String(v.sku || "").trim().toLowerCase()).filter(Boolean)
  );

  const activeFeedOptionsKeys = new Set(
    productObj.variants.map(v =>
      (v.optionValues || [])
        .map(ov => `${normalizeString(ov.optionName)}:${normalizeString(ov.name)}`)
        .sort()
        .join("|")
    ).filter(Boolean)
  );

  // ── CORRECCIÓN ORDEN DE OPERACIONES ─────────────────────────────────────
  // La purga de variantes obsoletas se calcula aquí pero se ejecuta AL FINAL,
  // después de crear y actualizar las variantes del feed.
  //
  // Problema original: la purga se ejecutaba antes de crear las variantes
  // nuevas. Si el producto estaba a medias (solo tenía la placeholder con
  // Title:Default Title), el flujo era:
  //   1. DELETE placeholder  → producto sin ninguna variante
  //   2. VARIANTS_CREATE     → falla porque el producto no tiene opciones reales
  //   → producto queda vacío en Shopify indefinidamente
  //
  // Solución: calcular qué hay que borrar ahora (antes de modificar nada),
  // pero ejecutar el DELETE solo después de que las variantes reales ya
  // existan en Shopify. Así el producto nunca queda sin variantes.
  // Set mutable: se eliminan los IDs a medida que el bucle de clasificación
  // encuentra matches, para que la purga no borre variantes que el feed reclamó
  // (aunque sea via barcode u opciones con un SKU distinto).
  const variantsToDeleteSet = new Set(
    productVariants
      .filter(ev => {
        // Excluir siempre la variante Title/Default Title — la elimina Shopify
        // automáticamente con REMOVE_STANDALONE_VARIANT al crear variantes reales.
        if (isTitleVariant(ev)) return false;

        const shopifySku = String(ev.sku || "").trim().toLowerCase();

        if (shopifySku) return !activeSkusInFeed.has(shopifySku);

        const evOptionsKey = buildOptionsKeyFromSelectedOptions(ev.selectedOptions || []);
        return !activeFeedOptionsKeys.has(evOptionsKey);
      })
      .map(ev => String(ev.id))
  );

  groupsState[groupId].totalVariants += productObj.variants.length;
  const matchedShopifyIds = new Set();
  let skippedCount = 0;
  let detectedUpdateCount = 0;
  let detectedCreateCount = 0;

  productObj.variants.forEach(variant => {
    logger.detail(`SKU: ${variant.sku} | Price: ${variant.price} | Opciones: ${variant.optionValues.map(ov => `${ov.optionName}:${ov.name}`).join(", ")}`);
  });

  // Iterar variantes del feed y clasificarlas en crear/actualizar/saltar
  for (const variant of productObj.variants) {
    const variantInfo = {
      sku: variant.sku,
      image: variant.image,
      capacity: variant.optionValues.find(ov => ov.optionName.toLowerCase() === 'capacidad')?.name || '',
      color: variant.optionValues.find(ov => ov.optionName.toLowerCase() === 'color')?.name || '',
      condition: variant.optionValues.find(ov => ov.optionName.toLowerCase() === 'condición')?.name || ''
    };

    sendProgress({ type: "variant_processing_start", groupId, productId: existing.id, variant: variantInfo });

    if (variant.image) {
      const dimensions = await getImageDimensions(variant.image);
      if (isImageSmall(dimensions)) {
        sendProgress({ type: "variant_image_too_small", groupId, productId: existing.id, variant: { ...variantInfo, imageDimensions: dimensions } });
      }
    }

    // ── CORRECCIÓN BUG #1 ── Validar precio antes de clasificar la variante,
    // tanto en el caso de creación como en el de actualización.
    //
    // Problema original: la comprobación de precio inválido solo se ejecutaba
    // en la rama "crear variante" (cuando no había match en Shopify). Si la
    // variante ya existía en Shopify y el feed traía un precio inválido (0,
    // NaN o vacío), se clasificaba igualmente como "actualizar" y se enviaba
    // a Shopify con ese precio roto.
    //
    // Solución: validar el precio al principio del bucle, antes de cualquier
    // clasificación, y descartar la variante en ambos casos si no es válido.
    const cleanPrice = parseFloat(variant.price);
    if (!variant.price || isNaN(cleanPrice) || cleanPrice <= 0) {
      logger.warn(`⚠️ [SKIP/invalid_price] SKU: ${variant.sku || 'Desconocido'} precio inválido (${variant.price}). Revisar XML.`);
      sendProgress({ type: "variant_processing_success", groupId, productId: existing.id, action: "skipped", skipReason: "invalid_price", variant: variantInfo });
      skippedCount++;
      groupsState[groupId].processedVariants++;
      if (groupsState[groupId].processedVariants === groupsState[groupId].totalVariants) {
        sendProgress({ type: groupsState[groupId].hasErrors ? "group_error" : "group_success", id: groupId });
      }
      continue;
    }

    variant.mediaId = imageMap[variant.image] || null;

    let match = findVariant(productVariants, variant);

    // ── CORRECCIÓN "Product variant does not exist" ──────────────────────────
    // Si el match encontrado ES la variante Title/Default Title, ignorarlo
    // y forzar que la variante vaya a variantsToCreate. REMOVE_STANDALONE_VARIANT
    // en VARIANTS_CREATE eliminará la Title automáticamente al crear la primera
    // variante real, independientemente de si tiene SKU asignado o no.
    if (match && isTitleVariant(match)) {
      logger.info(`🔄 [Placeholder] Match es variante Title — forzando creación para SKU: ${variant.sku}`);
      match = null;
    }

    // Cuando una variante del feed reclama una variante de Shopify (por SKU,
    // barcode u opciones), sacarla de la lista de purga aunque su SKU antiguo
    // no estuviera en activeSkusInFeed. Sin esto, el flujo era:
    //   1. findVariant → match por opciones (SKU distinto en Shopify)
    //   2. no_changes/update → skip o actualización correcta
    //   3. purga borra esa misma variante porque su SKU original no era activo
    //   → la variante desaparece del panel aunque el sync la "vio"
    if (match) {
      variantsToDeleteSet.delete(match.id);
    }

    if (match) {
      if (matchedShopifyIds.has(match.id)) {
        logger.skip(`⏭️ [SKIP/duplicate_match] SKU ${variant.sku}: variante Shopify (${match.id}) ya procesada por otro SKU del feed.`);
        sendProgress({ type: "variant_processing_success", groupId, productId: existing.id, action: "skipped", skipReason: "duplicate_match", variant: variantInfo });
        skippedCount++;
        groupsState[groupId].processedVariants++;
        if (groupsState[groupId].processedVariants === groupsState[groupId].totalVariants) {
          sendProgress({ type: groupsState[groupId].hasErrors ? "group_error" : "group_success", id: groupId });
        }
        continue;
      }

      matchedShopifyIds.add(match.id);
      const variantForUpdate = { ...variant, id: match.id };

      if (variantNeedsUpdate(match, variantForUpdate) && !isDuplicateVariant(variantsToUpdate, variantForUpdate)) {
        sendProgress({ type: "variant_update_detected", groupId, productId: existing.id, variant: variantInfo });
        detectedUpdateCount++;
        variantsToUpdate.push(variantForUpdate);
        continue;
      }
    } else {
      if (!isDuplicateVariant(variantsToCreate, variant)) {
        sendProgress({ type: "variant_create_detected", groupId, productId: existing.id, variant: variantInfo });

        // Nota: la validación de precio se ha movido al principio del bucle
        // (CORRECCIÓN BUG #1) para cubrir también el caso de actualización.

        detectedCreateCount++;
        variantsToCreate.push(variant);
        continue;
      }
    }

    if (match) {
      logger.skip(`⏭️ [SKIP/no_changes] SKU ${variant.sku}: existe en Shopify (ID: ${match.id}) sin cambios detectados — price=${match.price} sku=${match.sku} opciones=${match.optionsKey}`);
      sendProgress({ type: "variant_processing_success", groupId, productId: existing.id, action: "skipped", skipReason: "no_changes", variant: variantInfo });
    } else {
      logger.skip(`⏭️ [SKIP/duplicate_create] SKU ${variant.sku}: opciones [${buildOptionsKeyFromOptionValues(variant.optionValues)}] ya en cola de creación.`);
      sendProgress({ type: "variant_processing_success", groupId, productId: existing.id, action: "skipped", skipReason: "duplicate_create", variant: variantInfo });
    }
    skippedCount++;
    groupsState[groupId].processedVariants++;
    if (groupsState[groupId].processedVariants === groupsState[groupId].totalVariants) {
      sendProgress({ type: groupsState[groupId].hasErrors ? "group_error" : "group_success", id: groupId });
    }
  }

  // Bulk create
  if (variantsToCreate.length > 0) {
    variantsToCreate.forEach(v =>
      logger.detail(`Variante a crear — SKU: ${v.sku} | Price: ${v.price} | Opciones: ${v.optionValues.map(ov => `${ov.optionName}:${ov.name}`).join(", ")}`)
    );

    // ── CORRECCIÓN BUG #2 ── Usar `type` en lugar de `step` en sendProgress.
    //
    // Problema original: este evento usaba la clave `step` mientras que todos
    // los demás eventos del sistema usan `type`. El cliente SSE filtra por
    // `type`, por lo que este evento nunca se procesaba correctamente y el
    // tracking de progreso no contabilizaba la fase de creación en bulk.
    sendProgress({ type: "variants-batch-create", productId: existing.id, count: variantsToCreate.length, groupId });

    const converted = variantsToCreate.map(v => ({ ...sanitizeVariantForGraphQL(convertVariantForShopify(v, imageMap)) }));

    // Usar REMOVE_STANDALONE_VARIANT SOLO si el producto únicamente tiene
    // el placeholder "Title/Default Title". Si ya tiene variantes reales,
    // Shopify trata la única variante existente como "standalone" y la
    // elimina al crear una nueva — borrando variantes legítimas.
    const hasOnlyPlaceholder = productVariants.length > 0 && productVariants.every(isTitleVariant);
    logger.info(`ℹ️ [VARIANTS_CREATE] hasOnlyPlaceholder=${hasOnlyPlaceholder} (${productVariants.length} variantes en Shopify, ${variantsToCreate.length} a crear)`);

    try {
      const variantsCreateRes = await adminGraphql(admin, VARIANTS_CREATE, {
        productId: existing.id,
        variants: converted.map(v => {
          const { sku, ...rest } = v;
          return { ...rest, inventoryItem: { sku } };
        }),
        ...(hasOnlyPlaceholder ? { strategy: "REMOVE_STANDALONE_VARIANT" } : {})
      });
      const variantsData = await variantsCreateRes.json();

      logger.success(`✅ [POST-CREAR] Variantes inyectadas con éxito en Shopify.`);
      variantsData?.data?.productVariantsBulkCreate?.productVariants?.forEach(pv =>
        logger.detail(`Creada en Shopify → ID: ${pv.id} | Precio: ${pv.price || '0? (Revisar)'}`)
      );

      const variantsCreateError = variantsData?.data?.productVariantsBulkCreate?.userErrors || [];

      if (variantsCreateError.length) {
        variantsCreateError.forEach((err, index) => {
          const isDuplicate = (err.message || "").toLowerCase().includes("duplicated input value") ||
                              (err.message || "").toLowerCase().includes("already exists");
          if (isDuplicate) {
            sendProgress({ type: "variant_processing_success", groupId, productId: existing.id, action: "skipped", variant: variantsToCreate[index] || null });
          } else {
            const failedVariant = variantsToCreate[index];
            logger.error(`❌ [VARIANTS_CREATE error] SKU: ${failedVariant?.sku || '?'} — "${err.message}" (campo: ${err.field || 'N/A'})`);
            logger.detail(`Opciones del feed:    [${(failedVariant?.optionValues || []).map(ov => `${ov.optionName}:${ov.name}`).join(' | ')}]`);
            logger.detail(`Opciones en Shopify:  [${currentOptions.map(o => `${o.name}:[${(o.optionValues || []).map(v => v.name).join(', ')}]`).join(' | ')}]`);
            sendProgress({ type: "variant_processing_error", groupId, productId: existing.id, message: err.message || "Error creando variante", variant: variantsToCreate[index] || null });
            groupsState[groupId].hasErrors = true;
          }
          groupsState[groupId].processedVariants++;
        });
      } else {
        created += variantsToCreate.length;
        for (const v of variantsToCreate) {
          sendProgress({ type: "variant_processing_success", groupId, productId: existing.id, action: "created",
            variant: { sku: v.sku, image: v.image, capacity: v.optionValues.find(ov => ov.optionName.toLowerCase() === 'capacidad')?.name || '', color: v.optionValues.find(ov => ov.optionName.toLowerCase() === 'color')?.name || '', condition: v.optionValues.find(ov => ov.optionName.toLowerCase() === 'condición')?.name || '' }
          });
          groupsState[groupId].processedVariants++;
        }
      }
    } catch (err) {
      logger.warn(`⚠️ Error creating variants:`, err);
    }
  }

  // Bulk update
  if (variantsToUpdate.length > 0) {
    variantsToUpdate.forEach(v =>
      logger.detail(`Variante a actualizar — ID: ${v.id} | SKU: ${v.sku} | Price: ${v.price} | Opciones: ${v.optionValues.map(ov => `${ov.optionName}:${ov.name}`).join(", ")}`)
    );
    sendProgress({ type: "variants-batch-update", productId: existing.id, count: variantsToUpdate.length, groupId });

    const converted = variantsToUpdate.map(v => ({ id: v.id, ...sanitizeVariantForGraphQL(convertVariantForShopify(v, imageMap)) }));
    try {
      const variantsUpdateRes = await adminGraphql(admin, VARIANTS_UPDATE, {
        productId: existing.id,
        variants: converted.map(v => {
          const { sku, ...rest } = v;
          return { ...rest, inventoryItem: { sku } };
        })
      });
      const variantsUpdateData = await variantsUpdateRes.json();

      logger.success(`✅ [POST-ACTUALIZAR] Variantes modificadas con éxito en Shopify.`);
      variantsUpdateData?.data?.productVariantsBulkUpdate?.productVariants?.forEach(pv =>
        logger.detail(`Actualizada en Shopify → ID: ${pv.id} | SKU: ${pv.inventoryItem.sku} | Precio: ${pv.price}`)
      );

      const variantsUpdateError = variantsUpdateData?.data?.productVariantsBulkUpdate?.userErrors || [];

      if (variantsUpdateError.length) {
        variantsUpdateError.forEach((err, index) => {
          const isAlreadyExists = (err.message || "").toLowerCase().includes("duplicated input value") ||
                                  (err.message || "").toLowerCase().includes("already exists");
          if (isAlreadyExists) {
            sendProgress({ type: "variant_processing_success", groupId, productId: existing.id, action: "skipped", variant: variantsToUpdate[index] || null });
          } else {
            const failedVariant = variantsToUpdate[index];
            logger.error(`❌ [VARIANTS_UPDATE error] SKU: ${failedVariant?.sku || '?'} ID: ${failedVariant?.id || '?'} — "${err.message}" (campo: ${err.field || 'N/A'})`);
            logger.detail(`Opciones del feed:    [${(failedVariant?.optionValues || []).map(ov => `${ov.optionName}:${ov.name}`).join(' | ')}]`);
            logger.detail(`Opciones en Shopify:  [${currentOptions.map(o => `${o.name}:[${(o.optionValues || []).map(v => v.name).join(', ')}]`).join(' | ')}]`);
            sendProgress({ type: "variant_processing_error", groupId, productId: existing.id, message: err.message || "Error creando variante", variant: variantsToUpdate[index] || null });
            groupsState[groupId].hasErrors = true;
          }
        });
      } else {
        for (const v of variantsToUpdate) {
          sendProgress({ type: "variant_processing_success", groupId, productId: existing.id, action: "updated",
            variant: { sku: v.sku, image: v.image, capacity: v.optionValues.find(ov => ov.optionName.toLowerCase() === 'capacidad')?.name || '', color: v.optionValues.find(ov => ov.optionName.toLowerCase() === 'color')?.name || '', condition: v.optionValues.find(ov => ov.optionName.toLowerCase() === 'condición')?.name || '' }
          });
          groupsState[groupId].processedVariants++;
          if (groupsState[groupId].processedVariants === groupsState[groupId].totalVariants) {
            sendProgress({ type: groupsState[groupId].hasErrors ? "group_error" : "group_success", id: groupId });
          }
        }
        updated += converted.length;
      }
    } catch (err) {
      logger.warn(`⚠️ Error updating variants:`, err);
    }
  }

  // ── PURGA ── Ejecutar aquí, después de crear y actualizar variantes.
  // Las variantes nuevas ya existen en Shopify en este punto, así que
  // el producto nunca queda sin variantes durante el proceso.
  if (variantsToDeleteSet.size > 0) {
    const variantsBeingDeleted = productVariants
      .filter(v => variantsToDeleteSet.has(String(v.id)))
      .map(v => ({
        id: v.id,
        sku: v.sku || null,
        options: (v.selectedOptions || []).map(so => ({ name: so.name, value: so.value }))
      }));

    variantsBeingDeleted.forEach(v =>
      logger.warn(`🗑️ [PURGA] Eliminando — SKU: ${v.sku || 'N/A'} | Opciones: ${v.options.map(o => `${o.name}:${o.value}`).join(', ')}`)
    );

    sendProgress({
      type: "variants_purged",
      groupId,
      productId: existing.id,
      variants: variantsBeingDeleted
    });

    try {
      const deleteRes = await adminGraphql(admin, VARIANTS_DELETE, {
        productId: existing.id,
        variantsIds: Array.from(variantsToDeleteSet)
      });
      const deleteData = await deleteRes.json();
      const deleteErrors = deleteData?.data?.productVariantsBulkDelete?.userErrors || [];

      if (deleteErrors.length) {
        logger.error(`❌ [ERROR PURGA] ID: ${existing.id}:`, deleteErrors);
        sendProgress({ type: "variants_purge_error", groupId, productId: existing.id, errors: deleteErrors });
      } else {
        logger.warn(`✅ [PURGA] ${variantsBeingDeleted.length} variante(s) eliminadas del producto ${existing.id}`);
      }
    } catch (e) {
      logger.error(`❌ [ERROR PURGA] ID: ${existing.id} — ${e.message || String(e)}`);
      sendProgress({ type: "variants_purge_error", groupId, productId: existing.id, errors: [{ message: e.message || String(e) }] });
    }
  }

  // ── CORRECCIÓN BUG #3 ── Eliminar v.id del log de variantes del feed.
  //
  // Problema original: el log de processGroup imprimía `v.id` sobre variantes
  // del feed, pero ese campo no existe en ese punto (lo asigna Shopify tras la
  // creación). El resultado era que siempre se logueaba `undefined`.
  // El log se ha movido aquí, donde ya tenemos el contexto correcto, y se usa
  // `v.sku` que sí está disponible desde el feed.
  logger.info(`📋 [PLAN] Producto: ${productObj.title.padEnd(25)} | Existentes: ${productVariants.length} | Mantener: ${matchedShopifyIds.size} | Crear: ${detectedCreateCount} | Actualizar: ${detectedUpdateCount} | Ignorar: ${skippedCount}`);

  return { created, updated, unchanged: created === 0 && updated === 0 };
}

// Procesa un grupo de items del feed: crea o actualiza el producto en Shopify
// y sincroniza sus variantes, imágenes y metafields.
async function processGroup(admin, groupId, groupItems) {
  const publicationsRes = await adminGraphql(admin, GET_PUBLICATIONS);
  const publicationsData = await publicationsRes.json();
  const allPublications = publicationsData?.data?.publications?.edges || [];
  const publicationsIDs = allPublications
    .filter(pub =>
      pub.node.name === 'Tienda Online' ||
      pub.node.name === 'Online Store' ||
      pub.node.name === 'Shop' ||
      pub.node.name === 'Shopify GraphiQL App'
    ).map(pub => ({ publicationId: pub.node.id })) || [];

  if (publicationsIDs.length === 0) {
    logger.warn(`⚠️ [PUBLICACIÓN] No se encontró ningún canal de ventas conocido. Canales disponibles: ${allPublications.map(e => `"${e.node.name}"`).join(', ')}. El producto quedará en Draft.`);
  } else {
    logger.detail(`[PUBLICACIÓN] Publicando en ${publicationsIDs.length} canal(es).`);
  }

  // Descripción por IA, perezosa y cacheada por modelKey. Devuelve null si no
  // hay clave, si falla o si el resultado no pasa el saneado; en ese caso
  // buildShopifyProductObject deja descriptionHtml a null y se omite del
  // payload, sin tocar la descripción que ya tuviera el producto en Shopify.
  const aiDescription = await ensureDescription(
    groupId,
    groupItems[0]?.modelTitle,
    groupItems[0]?.brand
  );

  const productObj = buildShopifyProductObject(groupItems, aiDescription);

  if (!productObj?.variants?.length) {
    // ── NUEVO ── Si todas las variantes del grupo han sido descartadas
    // (porque todas son out_of_stock en el feed), el comportamiento depende
    // de si el producto ya existe en Shopify:
    //
    //   - Si existe: eliminarlo completamente. No tiene sentido mantener
    //     un producto sin ninguna variante con stock en la tienda.
    //
    //   - Si no existe: simplemente ignorarlo. No hay nada que crear ni
    //     que borrar, y loguear la situación para trazabilidad.
    const existingForDelete = await findExistingProduct(admin, groupItems);

    if (existingForDelete) {
      logger.warn(`🗑️ [OUT_OF_STOCK] Eliminando producto sin stock: ${existingForDelete.id} — ${groupItems[0]?.modelTitle}`);
      try {
        const deleteRes = await adminGraphql(admin, PRODUCT_DELETE, { id: existingForDelete.id });
        const deleteData = await deleteRes.json();
        const deleteErrors = deleteData?.data?.productDelete?.userErrors || [];

        if (deleteErrors.length) {
          logger.error(`❌ [OUT_OF_STOCK] Error eliminando producto ${existingForDelete.id}:`, deleteErrors);
          sendProgress({ type: "group_error", id: groupId, error: `Error eliminando producto sin stock: ${deleteErrors[0]?.message}` });
        } else {
          logger.success(`✅ [OUT_OF_STOCK] Producto eliminado: ${existingForDelete.id}`);
          sendProgress({ type: "group_deleted", id: groupId, productId: existingForDelete.id, reason: "out_of_stock" });
        }
      } catch (err) {
        logger.error(`❌ [OUT_OF_STOCK] Excepción eliminando producto ${existingForDelete.id}: ${err?.message || err}`);
        sendProgress({ type: "group_error", id: groupId, error: err?.message || String(err) });
      }
    } else {
      logger.info(`ℹ️ [OUT_OF_STOCK] Grupo ignorado (sin stock y sin producto en Shopify): ${groupItems[0]?.modelTitle}`);
      sendProgress({ type: "group_skipped", id: groupId, reason: "out_of_stock_no_product" });
    }

    return { success: false, product: null };
  }

  const existing = await findExistingProduct(admin, groupItems);

  if (!existing) {
    logger.section(`🚀 Creando producto: ${productObj.title}`);

    // CORRECCIÓN BUG #3: v.id no existe en variantes del feed antes de crearlas
    // en Shopify. Se usa v.sku, que sí está disponible desde el feed.
    productObj.variants.forEach(v =>
      logger.detail(`Variante detectada — SKU: ${v.sku} | Price: ${v.price} | Opciones: ${v.optionValues.map(ov => `${ov.optionName}:${ov.name}`).join(", ")}`)
    );

    // Se hoista fuera del try para poder devolver el ID del producto recién
    // creado aunque un paso posterior (sync de variantes, metafields, publish)
    // lance una excepción. Sin esto, la reconciliación final vería un producto
    // creado y ya etiquetado como "cosladafon" pero sin ID registrado, y lo
    // borraría como huérfano.
    let createdProduct = null;
    try {
      const { success, product, errors } = await createShopifyProduct(admin, productObj, groupId);

      if (!success || !product) {
        logger.warn(`⚠️ No se creó el producto`, productObj.title, errors);
        return { success: false, product: null, error: true };
      }
      createdProduct = product;

      sendProgress({ type: "product_created", groupId, result: { success, product } });

      // Pasar el objeto product completo (incluye options con id y optionValues)
      // para que syncExistingProduct pueda llamar a syncProductOptions con los
      // IDs reales de las opciones recién creadas por Shopify.
      const synced = await syncExistingProduct(admin, product, productObj, groupId);
      sendProgress({ type: "product_synced", groupId, createdVariants: synced.created, updatedVariants: synced.updated });

      await setProductMetafields(admin, product.id, groupItems);
      await adminGraphql(admin, PUBLISH_PRODUCT, { id: product.id, input: publicationsIDs });

      return { success, product, synced };
    } catch (err) {
      logger.error(`❌ Error creating product en processGroup:`, err);
      if (err.body?.errors) logger.error(`❌ An error occurred:`, err?.body.errors || err);
      // Devolver el producto creado (si lo hubo) para preservar su ID y marcar
      // el fallo, de modo que la reconciliación no lo borre y quede bloqueada.
      return { success: false, product: createdProduct, error: true };
    }
  } else {
    await updateShopifyProduct(admin, existing, productObj, groupId);

    // Pasar el objeto existing completo (incluye options con id y optionValues
    // desde PRODUCT_SEARCH) para que syncExistingProduct pueda sincronizar
    // las opciones con syncProductOptions antes de crear/actualizar variantes.
    const synced = await syncExistingProduct(admin, existing, productObj, groupId);
    await setProductMetafields(admin, existing.id, groupItems);
    await adminGraphql(admin, PUBLISH_PRODUCT, { id: existing.id, input: publicationsIDs });
    return { success: true, product: existing, synced };
  }
}

// ── RECONCILIACIÓN DE HUÉRFANOS ─────────────────────────────────────────────
// Elimina de la tienda los productos gestionados por la app (tag "cosladafon")
// cuyo modelo ya no aparece en ningún grupo del feed sincronizado.
//
// Motivación: el bucle principal de syncXmlString solo recorre los grupos que
// llegan en el XML. Un producto creado en una sync anterior cuyo modelo
// desaparece por completo del feed (no llega ni como out_of_stock) nunca es
// visitado y quedaría huérfano en la tienda indefinidamente.
//
// Estrategia:
//   1. Paginar todos los productos con el tag MANAGED_PRODUCT_TAG.
//   2. Restar los IDs que esta ejecución creó o actualizó (syncedProductIds).
//   3. Eliminar los sobrantes con PRODUCT_DELETE.
//
// El acotar el borrado al tag garantiza que jamás se toquen productos añadidos
// manualmente a la tienda. Solo se invoca cuando la sync termina completa (no
// cancelada), para no borrar productos de grupos que aún no se habían procesado.
async function reconcileOrphanProducts(admin, syncedProductIds) {
  logger.section(`🧹 Reconciliación de huérfanos (tag "${MANAGED_PRODUCT_TAG}")`);
  sendProgress({ type: "reconcile-start", message: "Buscando productos huérfanos" });

  // Paginar todos los productos gestionados por la app.
  const managedProducts = [];
  let cursor = null;
  try {
    do {
      const res = await adminGraphql(admin, GET_PRODUCTS_BY_TAG, {
        query: `tag:${MANAGED_PRODUCT_TAG}`,
        cursor,
      });
      const data = await res.json();
      const conn = data?.data?.products;
      const edges = conn?.edges || [];
      edges.forEach(e => e?.node?.id && managedProducts.push({ id: e.node.id, title: e.node.title }));
      cursor = conn?.pageInfo?.hasNextPage ? conn.pageInfo.endCursor : null;
    } while (cursor);
  } catch (err) {
    logger.error(`❌ [RECONCILE] Error listando productos gestionados: ${err?.message || err}`);
    sendProgress({ type: "reconcile-error", error: err?.message || String(err) });
    return;
  }

  // Los huérfanos son los productos con el tag que esta sync no tocó.
  const orphans = managedProducts.filter(p => !syncedProductIds.has(p.id));

  logger.info(`📋 [RECONCILE] Gestionados: ${managedProducts.length} | Sincronizados: ${syncedProductIds.size} | Huérfanos a eliminar: ${orphans.length}`);
  sendProgress({
    type: "reconcile-detected",
    managed: managedProducts.length,
    synced: syncedProductIds.size,
    orphans: orphans.map(o => ({ id: o.id, title: o.title })),
  });

  if (orphans.length === 0) {
    logger.success(`✅ [RECONCILE] No hay productos huérfanos.`);
    sendProgress({ type: "reconcile-end", deleted: 0 });
    return;
  }

  let deleted = 0;
  for (const orphan of orphans) {
    logger.warn(`🗑️ [RECONCILE] Eliminando huérfano: ${orphan.id} — ${orphan.title}`);
    try {
      const delRes = await adminGraphql(admin, PRODUCT_DELETE, { id: orphan.id });
      const delData = await delRes.json();
      const delErrors = delData?.data?.productDelete?.userErrors || [];

      if (delErrors.length) {
        logger.error(`❌ [RECONCILE] Error eliminando ${orphan.id}:`, delErrors);
        sendProgress({ type: "reconcile-product-error", productId: orphan.id, title: orphan.title, errors: delErrors });
      } else {
        deleted++;
        sendProgress({ type: "reconcile-product-deleted", productId: orphan.id, title: orphan.title });
      }
    } catch (err) {
      logger.error(`❌ [RECONCILE] Excepción eliminando ${orphan.id}: ${err?.message || err}`);
      sendProgress({ type: "reconcile-product-error", productId: orphan.id, title: orphan.title, errors: [{ message: err?.message || String(err) }] });
    }
  }

  logger.success(`✅ [RECONCILE] ${deleted}/${orphans.length} huérfano(s) eliminados.`);
  sendProgress({ type: "reconcile-end", deleted });
}

// Punto de entrada principal: descarga el XML, normaliza, agrupa y sincroniza
// todos los grupos de productos con Shopify.
export async function syncXmlString(admin, xmlString) {
  logger.info(`🚀 syncXmlString iniciado`);
  try {
    resetCancelFlag();
    await ensureProductMetafieldDefinitions(admin);
    logger.info(`🔄 Starting syncXmlString ...`);

    const result = await fetch(xmlString, { signal: AbortSignal.timeout(60000) });
    const xml = await result.text();
    const rawItems = parseXmlItems(xml);

    sendProgress({ type: "sync-start", message: "Sincronización iniciada", totalProducts: rawItems.length });

    // ── FASE IA 0: congelación de identidad (no bloqueante) ──
    try {
      const idn = await freezeLiveResolutions(admin, rawItems);
      sendProgress({ type: "ai-identity", ...idn });
    } catch (err) {
      logger.warn(`⚠️ [IDENTIDAD] No se pudo congelar: ${err?.message || err}`);
      sendProgress({ type: "ai-identity-error", error: err?.message || String(err) });
    }

    // ── FASE IA 1: resolución de modelos ────────────────────────────────────
    // No bloqueante: si falla, resolutions queda vacío y normalizeFeedItem
    // cae al extractor determinista de siempre.
    // Solo los items que pueden acabar en Shopify. El feed trae ~2.100
    // out_of_stock que normalizeFeedItem descarta: resolverlos con IA sería
    // tirar cuota y ~20 minutos por sync.
    const syncableItems = rawItems.filter(isSyncableItem);

    let resolutions = new Map();
    try {
      sendProgress({ type: "ai-resolve-start", total: syncableItems.length });
      // resolveModels emite su propio "ai-resolve-end" con el desglose.
      resolutions = await resolveModels(syncableItems);
    } catch (err) {
      logger.warn(`⚠️ [IA] Resolución de modelos no disponible, se usa el extractor: ${err?.message || err}`);
    }

    const normalized = rawItems
      .map(item => normalizeFeedItem(item, resolutions.get(buildCacheKey(item)) || null))
      .filter(Boolean);
    const groups = groupByModelKey(normalized);

    // Las descripciones NO se generan aquí: se piden de forma perezosa dentro
    // de processGroup (ensureDescription). Como pre-pasada bloqueaban la sync
    // varios minutos sin tocar Shopify; así los productos empiezan a
    // sincronizarse de inmediato y la latencia de la IA se solapa con el resto.

    sendProgress({ type: "groups-detected", groups });
    sendProgress({ type: "groups_list", groups: Object.keys(groups) });

    const results = {};
    let processedGroups = 0;
    // IDs de productos creados o actualizados en esta ejecución. Se usa en la
    // reconciliación final para no eliminar como huérfanos los productos que el
    // feed sí ha tocado.
    const syncedProductIds = new Set();
    // Se marca en cuanto un grupo falla de forma que deje el estado incierto
    // (excepción en el bucle o fallo real dentro de processGroup). Bloquea la
    // reconciliación: si no sabemos con certeza qué productos quedaron tocados,
    // no podemos arriesgarnos a borrar huérfanos que en realidad sí existen.
    let hadGroupError = false;
    logger.info(`🚀 Iniciando sincronización de ${Object.keys(groups).length} grupos de productos.`);

    for (const [groupId, groupItems] of Object.entries(groups)) {
      if (wasCancelled()) break;

      try {
        sendProgress({ type: "group_start", id: groupId, items: groupItems });
        groupsState[groupId] = { totalVariants: 0, processedVariants: 0, hasErrors: false };

        results[groupId] = await processGroup(admin, groupId, groupItems);

        // Registrar el producto tocado (creado o existente) para que la
        // reconciliación no lo considere huérfano.
        const touchedId = results[groupId]?.product?.id;
        if (touchedId) syncedProductIds.add(touchedId);

        // Un fallo real de processGroup (creación fallida, excepción interna)
        // deja el estado incierto: bloquear la reconciliación. Los grupos
        // out_of_stock devuelven success:false SIN error, y no cuentan aquí.
        if (results[groupId]?.error) hadGroupError = true;

        sendProgress({ type: "group_end", id: groupId, result: results[groupId] });
        processedGroups++;
        logger.info(`📊 Progreso: ${processedGroups}/${Object.keys(groups).length} grupos completados.`);
        sendProgress({ type: "overall_status", processed: processedGroups, total: Object.keys(groups).length });
      } catch (err) {
        logger.error(`❌ Error en Grupo [${groupId}]: ${err?.message || String(err)}`);
        results[groupId] = { success: false, error: err?.message || String(err) };
        hadGroupError = true;
        sendProgress({ type: "group_error", id: groupId, error: err?.message || String(err) });
      }
    }

    if (wasCancelled()) {
      logger.warn(`🛑 Sincronización cancelada por el usuario.`);
      sendProgress({ type: "sync-cancelled", message: "Sincronización cancelada" });
    } else {
      // Reconciliación final: eliminar los productos gestionados por la app
      // cuyo modelo ya no aparece en el feed. Solo se ejecuta cuando la sync
      // completa todos los grupos sin errores; si se canceló o algún grupo
      // falló, syncedProductIds estaría incompleto y podríamos borrar productos
      // que en realidad sí existen en el feed.
      if (hadGroupError) {
        logger.warn(`⚠️ [RECONCILE] Omitida: hubo errores en algún grupo. No se eliminan huérfanos para evitar borrados accidentales.`);
        sendProgress({ type: "reconcile-skipped", reason: "group_errors" });
      } else {
        await reconcileOrphanProducts(admin, syncedProductIds);
      }

      logger.success(`✨ Sincronización finalizada con éxito.`);
      sendProgress({ type: "sync-end", results });
    }
  } catch (err) {
    logger.error(`❌ syncXmlString error:`, err);
    // CORRECCIÓN BUG #2 (menor): el evento de error también usaba `step` en
    // lugar de `type`. Corregido para consistencia con el resto del sistema SSE.
    sendProgress({ type: "sync-error", error: err?.message || String(err) });
  }
}
