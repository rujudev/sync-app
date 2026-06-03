// sync-engine.js
// Orquesta el proceso completo de sincronización: descarga el XML,
// normaliza, agrupa y crea/actualiza productos y variantes en Shopify.

import { adminGraphql, log } from '../config.js';
import { sendProgress } from '../progress.js';
import { normalizeString } from '../../../utils/normalize-utils.js';
import { parseXmlItems } from './xml-parser.js';
import { normalizeFeedItem, groupByModelKey } from './feed-normalizer.js';
import { buildShopifyProductObject, convertVariantForShopify, sanitizeVariantForGraphQL, findVariant, variantNeedsUpdate, isDuplicateVariant, normalizeOptions, buildOptionsKeyFromSelectedOptions } from './product-builder.js';
import { buildImageMapByMatching, getProductMediaWithRetry, getImageDimensions, isImageSmall, extractBaseName } from '../media-utils.js';
import { findExistingProduct, createShopifyProduct, updateShopifyProduct, getAllProductVariants, setProductMetafields, ensureProductMetafieldDefinitions } from '../shopify-api.js';
import { resetCancelFlag, wasCancelled } from '../../routes/api.sync-cancel.js';
import {
  GET_PUBLICATIONS,
  PRODUCT_CREATE_MEDIA,
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
  log(`=========== 🔄 Sincronizando producto existente: ${existing.id} - ${productObj.title} ===========`);
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
 
  // Subir imágenes del producto
  if (productObj.images?.length) {
    try {
      const media = productObj.images.map((img, i) => ({
        mediaContentType: "IMAGE",
        originalSource: img.originalSrc,
        alt: `${productObj.title} - ${i + 1}`
      }));
 
      await adminGraphql(admin, PRODUCT_CREATE_MEDIA, { media, product: { id: existing.id } });
      sendProgress({ type: "product_media_uploaded", productId: existing.id, groupId, count: media.length });
 
      // ── CAMBIO 7 ── Pasar media.length como expectedCount para que
      // getProductMediaWithRetry (CAMBIO 6) espere a que todas las imágenes
      // subidas estén procesadas por Shopify antes de construir el imageMap.
      const newGetProductMediaRes = await getProductMediaWithRetry(admin, existing.id, 10, 2000, media.length);
      sendProgress({ type: "product_media_added", productId: existing.id, groupId });
 
      uploadedMediaNodes = newGetProductMediaRes;
      imageMap = buildImageMapByMatching(productObj, newGetProductMediaRes);
    } catch (err) {
      log(`⚠️ Error uploading media for new product:`, err);
      if (err.body?.errors) {
        log(`⚠️ Error uploading media for new product:`, err.body.errors);
        return ({ errors: err.body?.errors }, { status: 500 });
      }
    }
  }
 
  const variantsToUpdate = [];
  const variantsToCreate = [];
 
  const productVariants = await getAllProductVariants(admin, existing.id);
 
  // ── CAMBIO 4 (revisado) ── La placeholder de Shopify se ACTUALIZA con la
  // ─────────────────────────────────────────────────────────────────────────
  // primera variante real del feed, en lugar de eliminarse.
  //
  // Contexto: cuando Shopify crea un producto con productCreate, genera
  // automáticamente una variante vacía (sin SKU, sin precio, sin opciones).
  // No se puede evitar en la mutación de creación.
  //
  // Estrategia anterior (CAMBIO 4 original): eliminar la placeholder y crear
  // todas las variantes desde cero. Esto dejaba el producto sin ninguna
  // variante en el intervalo entre el delete y el create, lo que Shopify
  // no permite en ciertos contextos y causaba que la variante no apareciese.
  //
  // Estrategia correcta:
  //   1. Detectar la placeholder (sin SKU y sin barcode).
  //   2. Asignarle el ID de la primera variante real del feed → pasa a
  //      variantsToUpdate en lugar de variantsToCreate. Así Shopify actualiza
  //      esa variante existente con SKU, precio y opciones reales sin romper
  //      la integridad del producto.
  //   3. El resto de variantes reales se crean normalmente.
  //   4. Las variantes obsoletas (SKU ya no en el feed) sí se eliminan,
  //      pero solo cuando hay otras variantes que las sustituyan.
  // ─────────────────────────────────────────────────────────────────────────
 
  log(`🔍 [syncExistingProduct] productId=${existing.id} → ${productVariants.length} variantes existentes en Shopify`);
 
  // Detectar la placeholder (una sola variante sin SKU ni barcode)
  const placeholderVariant = productVariants.length === 1 &&
    !normalizeString(productVariants[0]?.sku) &&
    !normalizeString(productVariants[0]?.barcode)
    ? productVariants[0]
    : null;
 
  // Enriquecer cada variante de Shopify con sus claves normalizadas e imagen
  productVariants.forEach(v => {
    v.normalizedSku = normalizeString(v.sku);
    v.normalizedBarcode = normalizeString(v.barcode);
    v.optionsKey = buildOptionsKeyFromSelectedOptions(v.selectedOptions || []);
    v.normalizedOptions = normalizeOptions(v.selectedOptions);
 
    log(`   - Variante ID: ${v.id} | Price: ${v.price} | SKU: ${v.sku || 'N/A'} | Barcode: ${v.barcode || 'N/A'} | Opciones: ${v.selectedOptions?.map(so => `${so.name}:${so.value}`).join(", ")}`);
 
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
 
  // SKUs activos en el feed para detectar variantes obsoletas
  const activeSkusInFeed = new Set(
    productObj.variants.map(v => String(v.sku || "").trim().toLowerCase()).filter(Boolean)
  );
 
  // Eliminar solo variantes reales obsoletas (SKU ya no en el feed).
  // La placeholder NO se incluye aquí: se reutilizará como update
  // de la primera variante real en el bucle de más abajo.
  const variantsToDelete = productVariants
    .filter(ev => {
      const shopifySku = String(ev.sku || "").trim().toLowerCase();
      const isPlaceholder = !shopifySku && !normalizeString(ev.barcode);
      
      if (isPlaceholder) return false; // ← placeholder excluida del delete
      
      return !activeSkusInFeed.has(shopifySku);
    })
    .map(ev => String(ev.id));
 
  if (variantsToDelete.length > 0) {
    log(`🗑️  [PURGA] ID: ${existing.id} | Eliminando ${variantsToDelete.length} variantes obsoletas.`);
    try {
      await adminGraphql(admin, VARIANTS_DELETE, {
        productId: existing.id,
        variantsIds: variantsToDelete
      });
    } catch (e) {
      log(`❌ [ERROR PURGA] ID: ${existing.id} — ${e.message || String(e)}`);
    }
  }
 
  groupsState[groupId].totalVariants += productObj.variants.length;
  const matchedShopifyIds = new Set();
  let skippedCount = 0;
  let detectedUpdateCount = 0;
  let detectedCreateCount = 0;
 
  productObj.variants.forEach(variant => {
    console.log(`   - SKU: ${variant.sku} | Price: ${variant.price} | Opciones: ${variant.optionValues.map(ov => `${ov.optionName}:${ov.name}`).join(", ")}`);
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
 
    variant.mediaId = imageMap[variant.image] || null;
 
    // ── CAMBIO 5 (revisado) ── Si existe placeholder y aún no fue usada,
    // asignarla como match de la primera variante real del feed.
    // Esto convierte la variante vacía de Shopify en una variante real
    // mediante un update (SKU, precio, opciones), sin eliminarla previamente.
    // Para variantes posteriores, findVariant busca por SKU/barcode/opciones
    // de forma normal entre las variantes ya reales de Shopify.
    let match = findVariant(productVariants, variant);
 
    if (!match && placeholderVariant && !matchedShopifyIds.has(placeholderVariant.id)) {
      log(`🔄 [Placeholder] Reutilizando variante vacía ${placeholderVariant.id} para SKU: ${variant.sku}`);
      match = placeholderVariant;
    }
 
    if (match) {
      if (matchedShopifyIds.has(match.id)) {
        sendProgress({ type: "variant_processing_success", groupId, productId: existing.id, action: "skipped", variant: variantInfo });
        skippedCount++;
        groupsState[groupId].processedVariants++;
        if (groupsState[groupId].processedVariants === groupsState[groupId].totalVariants) {
          sendProgress({ type: groupsState[groupId].hasErrors ? "group_error" : "group_success", id: groupId });
        }
        continue;
      }
 
      matchedShopifyIds.add(match.id);
      const variantForUpdate = { ...variant, id: match.id, selectedOptions: variant.optionValues, normalizedOptions: variant.normalizedOptions };
 
      if (variantNeedsUpdate(match, variantForUpdate) && !isDuplicateVariant(variantsToUpdate, variantForUpdate)) {
        sendProgress({ type: "variant_update_detected", groupId, productId: existing.id, variant: variantInfo });
        detectedUpdateCount++;
        variantsToUpdate.push(variantForUpdate);
        continue;
      }
    } else {
      if (!isDuplicateVariant(variantsToCreate, variant)) {
        sendProgress({ type: "variant_create_detected", groupId, productId: existing.id, variant: variantInfo });
 
        const cleanPrice = parseFloat(variant.price);
        if (!variant.price || isNaN(cleanPrice) || cleanPrice <= 0) {
          log(`⚠️ [IGNORADO] SKU: ${variant.sku || 'Desconocido'} precio inválido (${variant.price}). Revisar XML.`);
          continue;
        }
 
        detectedCreateCount++;
        variantsToCreate.push(variant);
        continue;
      }
    }
 
    sendProgress({ type: "variant_processing_success", groupId, productId: existing.id, action: "skipped", variant: variantInfo });
    groupsState[groupId].processedVariants++;
    if (groupsState[groupId].processedVariants === groupsState[groupId].totalVariants) {
      sendProgress({ type: groupsState[groupId].hasErrors ? "group_error" : "group_success", id: groupId });
    }
  }
 
  // Bulk create
  if (variantsToCreate.length > 0) {
    variantsToCreate.forEach(v =>
      log(`   ✅ - Variante a crear SKU: ${v.sku} | Price: ${v.price} | Opciones: ${v.optionValues.map(ov => `${ov.optionName}:${ov.name}`).join(", ")}\n`)
    );
    sendProgress({ step: "variants-batch-create", productId: existing.id, count: variantsToCreate.length, groupId });
 
    const converted = variantsToCreate.map(v => ({ ...sanitizeVariantForGraphQL(convertVariantForShopify(v, imageMap)) }));
    try {
      const variantsCreateRes = await adminGraphql(admin, VARIANTS_CREATE, {
        productId: existing.id,
        variants: converted.map(v => {
          const { sku, ...rest } = v;
          return { ...rest, inventoryItem: { sku } };
        })
      });
      const variantsData = await variantsCreateRes.json();
 
      log(`✅ [POST-CREAR] Variantes inyectadas con éxito en Shopify.\n`);
      variantsData?.data?.productVariantsBulkCreate?.productVariants?.forEach(pv =>
        log(`   ✅ Creada en Shopify -> ID: ${pv.id} | Precio: ${pv.price || '0? (Revisar)'}\n`)
      );
 
      const variantsCreateError = variantsData?.data?.productVariantsBulkCreate?.userErrors || [];
 
      if (variantsCreateError.length) {
        variantsCreateError.forEach((err, index) => {
          const isDuplicate = (err.message || "").toLowerCase().includes("duplicated input value") ||
                              (err.message || "").toLowerCase().includes("already exists");
          if (isDuplicate) {
            sendProgress({ type: "variant_processing_success", groupId, productId: existing.id, action: "skipped", variant: variantsToCreate[index] || null });
          } else {
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
      log("⚠️ Error creating variants:", err);
    }
  }
 
  // Bulk update
  if (variantsToUpdate.length > 0) {
    variantsToUpdate.forEach(v =>
      log(`   🔍 - Variante a actualizar ID: ${v.id} | SKU: ${v.sku} | Price: ${v.price} | Opciones: ${v.optionValues.map(ov => `${ov.optionName}:${ov.name}`).join(", ")}\n`)
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
 
      log(`✅ [POST-ACTUALIZAR] Variantes modificadas con éxito en Shopify.`);
      variantsUpdateData?.data?.productVariantsBulkUpdate?.productVariants?.forEach(pv =>
        log(`   ⚡ Actualizada en Shopify -> ID: ${pv.id} | SKU: ${pv.inventoryItem.sku} | Precio: ${pv.price}`)
      );
 
      const variantsUpdateError = variantsUpdateData?.data?.productVariantsBulkUpdate?.userErrors || [];
 
      if (variantsUpdateError.length) {
        variantsUpdateError.forEach((err, index) => {
          const isAlreadyExists = (err.message || "").toLowerCase().includes("duplicated input value") ||
                                  (err.message || "").toLowerCase().includes("already exists");
          if (isAlreadyExists) {
            sendProgress({ type: "variant_processing_success", groupId, productId: existing.id, action: "skipped", variant: variantsToUpdate[index] || null });
          } else {
            sendProgress({ type: "variant_processing_error", groupId, productId: existing.id, message: err.message || "Error creando variante", variant: variantsToUpdate[index] || null });
            groupsState[groupId].hasErrors = true;
          }
        });
      } else {
        for (const v of variantsToUpdate) {
          sendProgress({ type: "variant_processing_success", groupId, productId: existing.id, action: "updated",
            variant: { sku: v.sku, image: v.image, capacity: v.optionValues.find(ov => ov.optionName.toLowerCase() === 'capacidad')?.name || '', color: v.optionValues.find(ov => ov.optionName.toLowerCase() === 'color')?.name || '', condition: v.optionValues.find(ov => ov.optionName.toLowerCase() === 'condición')?.name || '' }
          });
        }
        updated += converted.length;
      }
    } catch (err) {
      log("⚠️ Error updating variants:", err);
    }
  }
 
  log(`📋 [PLAN] Producto: ${productObj.title.padEnd(25)} | Existentes: ${productVariants.length} | Mantener: ${matchedShopifyIds.size} | Crear: ${detectedCreateCount} | Actualizar: ${detectedUpdateCount} | Ignorar: ${skippedCount}`);
 
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
    sendProgress({ type: "group_error", id: groupId, error: "No hay variantes válidas para crear el producto" });
    return { success: false, product: null };
  }
 
  const existing = await findExistingProduct(admin, groupItems);
 
  if (!existing) {
    log(`=========== 🚀 Creando producto: ${productObj.title} ===========`);
    productObj.variants.forEach(v =>
      log(`   🔍 Variante detectada ID: ${v.id} | SKU: ${v.sku} | Price: ${v.price} | Opciones: ${v.optionValues.map(ov => `${ov.optionName}:${ov.name}`).join(", ")}\n`)
    );
 
    try {
      const { success, product, errors } = await createShopifyProduct(admin, productObj, groupId);
 
      if (!success || !product) {
        log('⚠️ No se creó el producto', productObj.title, errors);
        return { success: false, product: null };
      }
 
      sendProgress({ type: "product_created", groupId, result: { success, product } });
 
      const synced = await syncExistingProduct(admin, { id: product.id }, productObj, groupId);
      sendProgress({ type: "product_synced", groupId, createdVariants: synced.created, updatedVariants: synced.updated });
 
      await setProductMetafields(admin, product.id, groupItems);
      await adminGraphql(admin, PUBLISH_PRODUCT, { id: product.id, input: publicationsIDs });
 
      return { success, product, synced };
    } catch (err) {
      log("⚠️ Error creating product en processGroup:", err);
      if (err.body?.errors) log("⚠️ An error occurred:", err?.body.errors || err);
    }
  } else {
    await updateShopifyProduct(admin, existing, productObj, groupId);
    const synced = await syncExistingProduct(admin, { id: existing.id }, productObj, groupId);
    await setProductMetafields(admin, existing.id, groupItems);
    await adminGraphql(admin, PUBLISH_PRODUCT, { id: existing.id, input: publicationsIDs });
    return { success: true, product: existing, synced };
  }
 
  return { success: false, product: null };
}
 
// Punto de entrada principal: descarga el XML, normaliza, agrupa y sincroniza
// todos los grupos de productos con Shopify.
export async function syncXmlString(admin, xmlString) {
  console.log('hemos entrado en syncXmlString');
  try {
    resetCancelFlag();
    await ensureProductMetafieldDefinitions(admin);
    log("🔄 Starting syncXmlString ...");
 
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
    log(`🚀 Iniciando sincronización de ${Object.keys(groups).length} grupos de productos.`);
 
    for (const [groupId, groupItems] of Object.entries(groups)) {
      if (wasCancelled()) break;
 
      try {
        sendProgress({ type: "group_start", id: groupId, items: groupItems });
        groupsState[groupId] = { totalVariants: 0, processedVariants: 0, hasErrors: false };
 
        results[groupId] = await processGroup(admin, groupId, groupItems);
 
        sendProgress({ type: "group_end", id: groupId, result: results[groupId] });
        processedGroups++;
        log(`📊 Progreso: ${processedGroups}/${Object.keys(groups).length} grupos completados.`);
        sendProgress({ type: "overall_status", processed: processedGroups, total: Object.keys(groups).length });
      } catch (err) {
        log(`❌ Error en Grupo [${groupId}]: ${err?.message || String(err)}`);
        results[groupId] = { success: false, error: err?.message || String(err) };
        sendProgress({ type: "group_error", id: groupId, error: err?.message || String(err) });
      }
    }
 
    if (wasCancelled()) {
      log("🛑 Sincronización cancelada por el usuario.");
      sendProgress({ type: "sync-cancelled", message: "Sincronización cancelada" });
    } else {
      log("✨ Sincronización finalizada con éxito.");
      sendProgress({ type: "sync-end", results });
    }
  } catch (err) {
    log("❌ syncXmlString error:", err);
    sendProgress({ step: "sync-error", error: err?.message || String(err) });
  }
}