// sync-engine.js
// Orquesta el proceso completo de sincronización: descarga el XML,
// normaliza, agrupa y crea/actualiza productos y variantes en Shopify.

import { adminGraphql, logger } from '../config.js';
import { sendProgress } from '../progress.js';
import { normalizeString } from '../../../utils/normalize-utils.js';
import { parseXmlItems } from './xml-parser.js';
import { normalizeFeedItem, groupByModelKey } from './feed-normalizer.js';
import { buildShopifyProductObject, convertVariantForShopify, sanitizeVariantForGraphQL, findVariant, variantNeedsUpdate, isDuplicateVariant, normalizeOptions, buildOptionsKeyFromSelectedOptions, buildOptionsKeyFromOptionValues } from './product-builder.js';
import { buildImageMapByMatching, getProductMediaWithRetry, getImageDimensions, isImageSmall, extractBaseName } from '../media-utils.js';
import { findExistingProduct, createShopifyProduct, updateShopifyProduct, getAllProductVariants, setProductMetafields, ensureProductMetafieldDefinitions, syncProductOptions } from '../shopify-api.js';
import { resetCancelFlag, wasCancelled } from '../../routes/api.sync-cancel.js';
import {
  GET_PUBLICATIONS,
  GET_PRODUCT_MEDIA,
  PRODUCT_CREATE_MEDIA,
  PRODUCT_DELETE,
  PUBLISH_PRODUCT,
  VARIANTS_CREATE,
  VARIANTS_UPDATE,
} from '../../shopify/queries';

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
  const variantsToDelete = productVariants
    .filter(ev => {
      // Excluir siempre la variante Title/Default Title — la elimina Shopify
      // automáticamente con REMOVE_STANDALONE_VARIANT al crear variantes reales.
      if (isTitleVariant(ev)) return false;

      const shopifySku = String(ev.sku || "").trim().toLowerCase();

      if (shopifySku) return !activeSkusInFeed.has(shopifySku);

      const evOptionsKey = buildOptionsKeyFromSelectedOptions(ev.selectedOptions || []);
      return !activeFeedOptionsKeys.has(evOptionsKey);
    })
    .map(ev => String(ev.id));

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
    try {
      const variantsCreateRes = await adminGraphql(admin, VARIANTS_CREATE, {
        productId: existing.id,
        variants: converted.map(v => {
          const { sku, ...rest } = v;
          return { ...rest, inventoryItem: { sku } };
        }),
        // ── NUEVO ── REMOVE_STANDALONE_VARIANT le indica a Shopify que elimine
        // automáticamente la variante placeholder "Default Title" al crear la
        // primera variante real. Esto evita el error "Option does not exist"
        // que ocurría cuando el producto aún tenía la opción genérica "Title"
        // en lugar de las opciones reales Capacidad/Color/Condición, sin
        // necesidad de gestionar manualmente la eliminación de la placeholder.
        strategy: "REMOVE_STANDALONE_VARIANT"
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
  if (variantsToDelete.length > 0) {
    logger.warn(`🗑️ [PURGA] ID: ${existing.id} | Eliminando ${variantsToDelete.length} variantes obsoletas.`);
    try {
      await adminGraphql(admin, VARIANTS_DELETE, {
        productId: existing.id,
        variantsIds: variantsToDelete
      });
    } catch (e) {
      logger.error(`❌ [ERROR PURGA] ID: ${existing.id} — ${e.message || String(e)}`);
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
  const publicationsIDs = publicationsData?.data?.publications?.edges
    .filter(pub =>
      pub.node.name === 'Tienda Online' ||
      pub.node.name === 'Online Store' ||
      pub.node.name === 'Shop' ||
      pub.node.name === 'Shopify GraphiQL App'
    ).map(pub => ({ publicationId: pub.node.id })) || [];

  const productObj = buildShopifyProductObject(groupItems);

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

    try {
      const { success, product, errors } = await createShopifyProduct(admin, productObj, groupId);

      if (!success || !product) {
        logger.warn(`⚠️ No se creó el producto`, productObj.title, errors);
        return { success: false, product: null };
      }

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

  return { success: false, product: null };
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

    const normalized = rawItems.map(normalizeFeedItem).filter(Boolean);
    const groups = groupByModelKey(normalized);

    sendProgress({ type: "groups-detected", groups });
    sendProgress({ type: "groups_list", groups: Object.keys(groups) });

    const results = {};
    let processedGroups = 0;
    logger.info(`🚀 Iniciando sincronización de ${Object.keys(groups).length} grupos de productos.`);

    for (const [groupId, groupItems] of Object.entries(groups)) {
      if (wasCancelled()) break;

      try {
        sendProgress({ type: "group_start", id: groupId, items: groupItems });
        groupsState[groupId] = { totalVariants: 0, processedVariants: 0, hasErrors: false };

        results[groupId] = await processGroup(admin, groupId, groupItems);

        sendProgress({ type: "group_end", id: groupId, result: results[groupId] });
        processedGroups++;
        logger.info(`📊 Progreso: ${processedGroups}/${Object.keys(groups).length} grupos completados.`);
        sendProgress({ type: "overall_status", processed: processedGroups, total: Object.keys(groups).length });
      } catch (err) {
        logger.error(`❌ Error en Grupo [${groupId}]: ${err?.message || String(err)}`);
        results[groupId] = { success: false, error: err?.message || String(err) };
        sendProgress({ type: "group_error", id: groupId, error: err?.message || String(err) });
      }
    }

    if (wasCancelled()) {
      logger.warn(`🛑 Sincronización cancelada por el usuario.`);
      sendProgress({ type: "sync-cancelled", message: "Sincronización cancelada" });
    } else {
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
