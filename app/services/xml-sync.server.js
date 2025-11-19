// xml-sync.server.js
// Reescrito: parser XML -> agrupar por item_group_id -> crear/actualizar producto + variantes
// Incluye: withRetry, media upload (productCreateMedia), búsqueda por item_group_id/handle,
// eventos SSE (attachSendProgress/sendProgress), logs detallados y procesamiento paralelo.

import { XMLParser } from "fast-xml-parser";
import COLOR_MAP from '../../color-dictionary.json';
import { resetCancelFlag, wasCancelled } from '../routes/api.sync-cancel.js';
import {
  GET_PRODUCT_MEDIA,
  GET_PRODUCT_VARIANTS,
  GET_PUBLICATIONS,
  PRODUCT_CREATE,
  PRODUCT_CREATE_MEDIA,
  PRODUCT_SEARCH,
  PUBLISH_PRODUCT,
  VARIANTS_CREATE,
  VARIANTS_UPDATE
} from '../shopify/queries';

// ====================== CONFIG & UTIL ======================
export const CONFIG = { LOG: true, RETRIES: 3, RETRY_BASE_DELAY_MS: 200 };
export const log = (...args) => CONFIG.LOG && console.log(new Date().toISOString(), ...args);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ====================== SEND EVENTS (SSE hook) ======================
let _sendProgress = null;
export function attachSendProgress(fn) {
  _sendProgress = fn;
}

function sendProgress(event) {
  if (_sendProgress) {
    try { _sendProgress(event); } catch (e) { console.warn("sendProgress failed", e); }
  }
}

// ====================== XML PARSER & NORMALIZER ======================
const xmlParser = new XMLParser({ ignoreAttributes: false });

function parseXmlItems(xmlString) {
  const json = xmlParser.parse(xmlString);
  console.log(json)
  const items = json?.rss?.channel?.item || [];
  return Array.isArray(items) ? items : [items];
}

// ----------------- Normalización helpers -----------------
function normalizeText(s = "") {
  return String(s || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "") // quita acentos
    .replace(/[^\w\s-]/g, " ") // reemplaza símbolos por espacio
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// Extrae un título "modelo" limpio: quita capacidad, color, paréntesis y tokens comunes
function extractModelTitle(title = "", brand = "") {
  if (!title) return (brand || "").trim();
  let t = String(title);

  // 1) quitar partes entre paréntesis: "(Negro)" etc.
  t = t.replace(/\([^)]+\)/g, " ");

  // 2) quitar capacidades tipo "128GB", "1TB"
  t = t.replace(/\b\d{1,4}\s?(GB|TB)\b/ig, " ");

  // 3) quitar tokens de color que aparezcan como palabras sueltas
  t = t.replace(/\b(negro|azul|gris|rojo|blanco|verde|amarillo|morado|rosa|plateado|crema|naranja|violeta|grafito|gold|silver|pink|black|white)\b/ig, " ");

  // 4) eliminar dobles espacios y trim
  t = t.replace(/\s+/g, " ").trim();

  // 5) quitar marcas o sufijos SKU si hay (ej: "SM-721B" o "S908B/DS")
  t = t.replace(/\b[Ss]\w{2,}-?\w*\b/g, " "); // heurística suave

  // 6) prefijar la marca si no está incluida en el título
  if (brand && !new RegExp(brand, "i").test(t)) {
    t = `${brand} ${t}`;
  }

  // normalizar caps: capitalizamos cada palabra para el title final
  return t.split(" ").filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join(" ");
}

function computeModelKey(title, brand) {
  // clave consistente para agrupar; minúsculas, sin acentos, sin signos
  return normalizeText(extractModelTitle(title, brand));
}

function uniqStrings(arr = []) {
  return Array.from(new Set(arr.filter(Boolean).map(s => String(s).trim()))).map(x => x);
}

function normalizeFeedItem(item) {
  const get = (f) => item[`g:${f}`] ?? item[f] ?? "";

  const title = String(get("title") || "");
  const brand = String(get("brand") || "");

  const capacityMatch = title.match(/(\d{1,4}GB|\d{1,4}TB)/i);

  // detecta color preferentemente desde <g:color>
  let colorRaw = (get("color") || "").toLowerCase().trim();

  // si no hay <g:color>, intenta extraer del título (paréntesis y últimos tokens)
  if (!colorRaw) {
    // 1) prueba contenido entre paréntesis
    const parenMatch = (title.match(/\(([^)]+)\)/) || [null, ""])[1].trim();
    if (parenMatch) {
      colorRaw = parenMatch.toLowerCase().trim();
    } else {
      // 2) intenta token final del título (últimas 1-3 palabras) si no son capacidades/sku
      const tailMatch = title.match(/(?:\b)([A-Za-zÀ-ÿ'\- ]{2,40})$/);
      if (tailMatch && !/\d/.test(tailMatch[1])) {
        colorRaw = tailMatch[1].toLowerCase().trim();
      }
    }
  }

  // normalizar múltiples variantes encontradas (ej: "graphite" -> "grafito")
  colorRaw = (colorRaw || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "");

  // si colorRaw contiene separadores, quedarse con la parte relevante
  colorRaw = colorRaw.split(/[\/,|-]/)[0].trim();

  // aplicar traducción si existe
  const colorFinal = COLOR_MAP[colorRaw] || colorRaw || "sin color";

  const modelTitle = extractModelTitle(title, brand);
  const modelKey = computeModelKey(title, brand);

  let priceRaw = String(get("price") || "").trim();
  priceRaw = priceRaw.split(" ")[0].replace(",", ".").replace(/[^\d.]/g, "");

  return {
    sku: String(get("id") || ""),
    groupId: get("item_group_id") || null,
    title,
    modelTitle,
    modelKey,
    description: (get("description") || "").replace(/Cosladafon/g, "Secondtech"),
    brand,
    capacity: capacityMatch ? capacityMatch[1].toUpperCase() : "Estándar",
    color: (colorFinal || "Sin color").toLowerCase(),
    condition: (get("condition") || "new").toLowerCase(),
    price: parseFloat(priceRaw) || null,
    image: get("image_link") || null,
    gtin: get("gtin") || null,
    availability: get("availability") || null,
    raw: item
  };
}


function groupByModelKey(items) {
  const groups = {};
  for (const item of items) {
    const key = item.modelKey || item.groupId || normalizeText(item.title);
    if (!groups[key]) groups[key] = [];
    groups[key].push(item);
  }
  return groups;
}

// ====================== GraphQL helper + withRetry ======================
async function withRetry(fn, retries = CONFIG.RETRIES, baseDelay = CONFIG.RETRY_BASE_DELAY_MS) {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      attempt++;
      const isThrottled = err?.message?.toLowerCase().includes("throttle") || err?.status === 429;
      if (attempt > retries) throw err;
      const delay = baseDelay * Math.pow(2, attempt - 1) * (isThrottled ? 2 : 1);
      log(`⚠️ GraphQL retry ${attempt}/${retries} after ${delay}ms — ${err?.message || err}`);
      await sleep(delay);
    }
  }
}

async function adminGraphql(admin, query, variables = {}) {
  // admin.graphql should return parsed JSON-like object (data / errors)
  try {
    return await withRetry(() => admin.graphql(query, { variables }));
  } catch(e) {
    if (e.response) {
      const text = await e.response.text();
      console.error("❌ adminGraphql error response text:", text);
      throw new Error(`GraphQL request failed: ${e?.message || String(e)} — Response: ${text}`);
    }
  }
}

// ====================== Find existing product (improved search) ======================
async function findExistingProduct(admin, group) {
  const first = group[0];
  const sku = first.sku;
  const title = first.modelTitle;
  const modelKey = first.modelKey;

  const handle = modelKey
    ? modelKey.replace(/[^\w\s-]/g, "").replace(/\s+/g, "-").slice(0, 80)
    : null;

  const queries = [];
  if (modelKey) queries.push(`tag:${modelKey}`);
  if (handle) queries.push(`handle:${handle}`);
  if (sku) queries.push(`sku:${sku}`);
  if (title) queries.push(`title:${title}`);
  
  try {
    const res = await adminGraphql(admin, PRODUCT_SEARCH, { query: `handle:${handle}` });
    const searchResults = await res.json();
    const edges = searchResults?.data?.products?.edges || [];

    log(`🔍 Búsqueda de producto existente con handle='${handle}' arrojó ${edges.length} resultados.`);
    if (edges.length > 0) {
      log(`✅ Producto encontrado por '${title}': ${edges[0].node.title}`);
      return edges[0].node;
    }
  } catch (err) {
    log(`⚠️ Error buscando producto con query="${title}": ${err?.message || err}`);
  }

  return null;
}

// ====================== Build Shopify product object ======================
function buildShopifyProductObject(group) {
  const base = group[0];

  const title = base.modelTitle;

  const capacities = uniqStrings(group.map(v => v.capacity )).map(c => ({ name: c }));
  const colors = uniqStrings(group.map(v => v.color)).map(c => ({ name: c }));
  const conditions = uniqStrings(group.map(v => v.condition)).map(c => ({ name: c }));

  console.table({ capacities, colors, conditions });

  const images = uniqStrings(group.map(v => v.image)).map(src => ({ originalSrc: src }));

  const variants = group.map((v) => ({
    sku: v.sku,
    barcode: String(v.gtin) || null,
    price: v.price != null ? Number(v.price).toFixed(2) : "0.00",
    inventoryPolicy: "CONTINUE",
    optionValues: [
      { optionName: "Capacidad", name: v.capacity },
      { optionName: "Color", name: v.color },
      { optionName: "Condición", name: v.condition },
    ],
    image: v.image || null
  }));

  return {
    title,
    vendor: "Cosladafon",
    descriptionHtml: base.description || "",
    productOptions: [
      { name: "Capacidad", values: capacities },
      { name: "Color", values: colors },
      { name: "Condición", values: conditions }
    ],
    images,
    variants
  };
}

function convertVariantForShopify(newVar, imageMap) {
  return {
    barcode: String(newVar.barcode),
    price: newVar.price,
    inventoryPolicy: "CONTINUE",
    optionValues: (newVar.optionValues || []).map(ov => ({
      optionName: ov.optionName,
      name: ov.name
    })),
    mediaId: imageMap[newVar.image]
      ? imageMap[newVar.image]
      : null
  };
}

function filterNewImages(existingProduct, newImages) {
  if (!existingProduct?.images?.edges) return newImages;

  const existingUrls = existingProduct.images.edges.map(i => i.node.url);
  return newImages.filter(img => !existingUrls.includes(img.originalSrc));
}

function buildImageMap(product) {
  const map = {};
  if (!product?.images?.edges) return map;

  for (const edge of product.images.edges) {
    map[edge.node.url] = edge.node.id;
  }
  return map;
}

function variantNeedsUpdate(existingVar, newVar) {
  if (existingVar.price !== newVar.price) return true;
  if (existingVar.sku !== newVar.sku) return true;
  if (existingVar.barcode !== newVar.barcode) return true;

  const newOpts = newVar.optionValues.map(o => `${o.optionName}:${o.name}`).join("|");
  const existOpts = existingVar.selectedOptions.map(o => `${o.name}:${o.value}`).join("|");

  return newOpts !== existOpts;
}

async function processVariantBatches(admin, productId, variants, isUpdate = false) {
  const size = 50;
  for (let i = 0; i < variants.length; i += size) {
    const batch = variants.slice(i, i + size);

    if (batch.length === 0) continue;

    if (isUpdate) {
      await adminGraphql(admin, VARIANTS_UPDATE, {
        productId,
        variants: batch
      });
    } else {
      await adminGraphql(admin, VARIANTS_CREATE, {
        productId,
        variants: batch
      });
    }
  }
}

// ====================== Create Product (with handle & tags & media) ======================
async function createShopifyProduct(admin, productObj, groupId = null) {
  // build input, include handle & tag for future searches
  const input = { ...productObj };
  
  log(`input before handle/tags:`, { ...input });
  if (groupId) {
    const handle = String(groupId).toLowerCase().replace(/[^\w\s-]/g, "").replace(/\s+/g, "-").slice(0, 80);
    input.handle = handle;
    input.tags = Array.from(new Set([...(input.tags || []), String(groupId)]));
  }

  sendProgress({ step: "product-create-request", title: input.title, groupId });

  try {
    sendProgress({
      type: "product-create-request",
      title: input.title,
      groupId
    });

    log(`🔄 Creating product:`, {
      title: input.title,
      vendor: input.vendor,
      descriptionHtml: input.descriptionHtml,
      handle: input.handle,
      tags: input.tags,
      productOptions: input.productOptions,
    });

    input.productOptions.forEach((opt) => log(" - Option:", opt.name, "Values:", opt.values.map(v => v.name).join(", ")));

    const response = await adminGraphql(admin, PRODUCT_CREATE, { product: {
      title: input.title,
      vendor: input.vendor,
      descriptionHtml: input.descriptionHtml,
      handle: input.handle,
      tags: input.tags,
      productOptions: input.productOptions,
    }});
    
    const productResult = await response.json();
    const productData = productResult?.data?.productCreate?.product;

    log(`✅ Created product:`, { ...productData });

    return { success: true, product: productData };
  } catch (err) {
    log("⚠️ Error creating product en createShopifyProduct:", err);
    if (err.body?.errors) {
      log("⚠️ Error creating product:", err?.body.errors || err);
      return ({ errors: err.body?.errors }, { status: 500 });
    }
    return ({ message: "An error occurred" }, { status: 500 });
  }
}

// ====================== Find variant helper ======================
function findVariant(existingVariants, newVariant) {
  // Busca variante por sku, barcode o combinación exacta de opciones
  return (
    existingVariants.find(ev =>
      ev.sku === newVariant.sku ||
      ev.barcode === newVariant.barcode ||
      (
        Array.isArray(ev.selectedOptions) && Array.isArray(newVariant.optionValues) &&
        ev.selectedOptions.length === newVariant.optionValues.length &&
        ev.selectedOptions.every((opt, idx) => {
          const newOpt = newVariant.optionValues[idx];
          return opt.name === newOpt.optionName && opt.value === newOpt.name;
        })
      )
    )
  ) ?? null;
}

function extractBaseName(url) {
  const file = url.split("/").pop();
  return file.split(".")[0]; // S25E512NEGROCN_0
}

function buildImageMapByMatching(productObj, uploadedNodes) {
  const map = {};

  for (const img of productObj.images) {
    const original = img.originalSrc;
    const base = extractBaseName(original); // S25E512NEGROCN_0

    // buscar cuál media subida contiene ese baseName
    const found = uploadedNodes.find(node =>
      node?.preview?.image?.url?.includes(base)
    );

    if (found) {
      map[original] = found.id;
    }
  }

  return map;
}

async function getProductMediaWithRetry(admin, productId, maxRetries = 5, delayMs = 2000) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const res = await adminGraphql(admin, GET_PRODUCT_MEDIA, { id: productId });
    const data = await res.json();
    const mediaNodes = data?.data?.product?.media?.nodes || []
    const urls = mediaNodes.map(m => m.preview?.image?.url).filter(Boolean);
    if (urls.length > 0) {
      return mediaNodes;
    }
    await new Promise(r => setTimeout(r, delayMs));
  }
  return [];
}

// ====================== Sync existing product (variants create/update + optional media) ======================
async function syncExistingProduct(admin, existing, productObj, groupId = null) {
  let created = 0;
  let updated = 0;

  log('Existing')
  log('================ Sync existing product =================');

  sendProgress({
    type: "variants-sync-start",
    productId: existing.id,
    groupId
  });

  log(`🔄 Syncing existing product:`, { ...existing });
  log(`With productObj:`, { ...productObj });

  let imageMap = {};

  // If productObj has images, try to upload them (won't automatically link to variants here)
  if (productObj.images && productObj.images.length) {
    try {
      const media = productObj.images.map((img, i) => ({
        mediaContentType: "IMAGE",
        originalSource: img.originalSrc,
        alt: `${productObj.title} - ${i + 1}`
      }));

      media.forEach((img) => log(" - Uploading image:", img.originalSource));
      
      const productCreateMediaRes = await adminGraphql(admin, PRODUCT_CREATE_MEDIA, { media, product: { id: existing.id } });
      const productCreateMediaData = await productCreateMediaRes.json();
      const productCreatedMedia = productCreateMediaData.data.productUpdate.product;

      log(`✅ Uploaded media for product ${existing.id}:`, { ...productCreatedMedia });

      const newGetProductMediaRes = await getProductMediaWithRetry(admin, existing.id);

      imageMap = buildImageMapByMatching(productObj, newGetProductMediaRes);
      
      sendProgress({
        type: "product-media-added",
        productId: existing.id,
        groupId,
        newGetProductMediaRes
      });
    } catch (err) {
      log(`⚠️ Error uploading media for new product:`, err);
      if (err.body?.errors) {
        log(`⚠️ Error uploading media for new product:`, err.body.errors);
        return ({ errors: err.body?.errors }, { status: 500 });
      }
    }
  }

  log(`Image map built:`, { ...imageMap });

  const variantsToUpdate = [];
  const variantsToCreate = [];

  const productVariantsRes = await adminGraphql(admin, GET_PRODUCT_VARIANTS, {
    query: `product_id:${existing.id?.split('/').pop()}`
  });
  const productVariantsData = await productVariantsRes.json();
  const productVariants = productVariantsData?.data?.productVariants?.nodes || [];

  // iterate variants
  for (const variant of productObj.variants) {
    // try match by sku, barcode, or optionValues
    // const selectedOptions = (variant.optionValues || []).map((ov) => ({ name: ov.optionName || ov.name || "", value: ov.name || "" }));
    const match = findVariant(productVariants, variant);

    log(`Se ha encontrado la variante:`, { match, variant });

    if (match) {
      if (variantNeedsUpdate(match, variant)) {
        variantsToUpdate.push({ ...variant, selectedOptions: variant.optionValues, id: match.id });
      }
    } else {
      variantsToCreate.push(variant)
    }
  }
  
  if (variantsToCreate.length > 0) {
    sendProgress({
      step: "variants-batch-create",
      productId: existing.id,
      count: variantsToCreate.length,
      groupId
    });

    
    const converted = variantsToCreate.map(v => ({ ...convertVariantForShopify(v, imageMap) }));
    // const variantsRes = await processVariantBatches(admin, existing.id, converted, false);
    
    converted.forEach(v => log("➕ Creating variant:", { ...v }));

    try {
      log(`Existing product ID: ${existing.id}`);
      const variantsCreateRes = await adminGraphql(admin, VARIANTS_CREATE, {
        productId: existing.id,
        variants: converted
      });
  
      const variantsData = await variantsCreateRes.json();

      log(`Variants data after creation:`, { ...variantsData });

      if (variantsData?.data?.productVariantsBulkCreate?.userErrors?.length) {
        log("⚠️ Variant creation errors:", variantsData.data.productVariantsBulkCreate.userErrors);
      } else {
        log(`➕ Created ${converted.length} variants for product ${existing.id}`);
      }
      const productVariants = variantsData?.data?.productVariantsBulkCreate?.productVariants || [];
  
      productVariants?.forEach(v => log("➕ Created variant:", { ...v }));
    } catch (err) {
      log("⚠️ Error creating variants:", err);
    }
  }

  if (variantsToUpdate.length > 0) {
    sendProgress({
      type: "variants-batch-update",
      productId: existing.id,
      count: variantsToUpdate.length,
      groupId
    });

    const converted = variantsToUpdate.map(v => ({ id: v.id, ...convertVariantForShopify(v, imageMap)}) );

    log(`🔁 Updating variants:`);
    console.table({ converted });

    // const resUpdate = await processVariantBatches(admin, existing.id, converted, true);
    const variantsUpdateRes = await adminGraphql(admin, VARIANTS_UPDATE, {
      productId: existing.id,
      variants: converted
    });
    const variantsUpdateData = await variantsUpdateRes.json();
    const errs = variantsUpdateData?.data?.productVariantsBulkUpdate?.userErrors;
    
    if (errs?.length) {
      log("⚠️ Variant update errors:", errs);
    } else {
      log(`🔁 Updated ${converted.length} variants for product ${existing.id}`);
      updated += converted.length;
    }
  }

  return { created, updated };
}

// ====================== Process single group ======================
async function processGroup(admin, groupId, groupItems) {
  sendProgress({
    type: "processing-group",
    groupId,
    count: groupItems.length
  });

  log(`➡️ Processing groupId='${groupId}' (${groupItems.length} items)`);

  const publicationsRes = await adminGraphql(admin, GET_PUBLICATIONS);
  const publicationsData = await publicationsRes.json();
  const publicationsIDs = publicationsData?.data?.publications?.edges
    .filter(pub => 
      pub.node.name === 'Tienda Online' ||
      pub.node.name === 'Online Store' ||
      pub.node.name === 'Shop' || 
      pub.node.name === 'Shopify GraphiQL App'
    ).map(pub => ({ publicationId: pub.node.id}) ) || [];

  let productObj = buildShopifyProductObject(groupItems);

  // find existing
  const existing = await findExistingProduct(admin, groupItems);

  if (!existing) {
    log("🟢 Creating product:", productObj.title);
    
    try {
      const { success, product } = await createShopifyProduct(admin, productObj, groupId);

      sendProgress({
        type: "group-created",
        groupId,
        result: { success, product }
      });

      log(`Success: ${success}, created product:`, { ...product });

      const synced = await syncExistingProduct(admin, { id: product.id }, productObj, groupId);

      sendProgress({ step: "group-updated", groupId, result: synced });

      log(`📢 Publishing product ${product.id} to publications:`, publicationsIDs);
      await adminGraphql(admin, PUBLISH_PRODUCT, {
        id: product.id,
        input: publicationsIDs
      });
  
      log(`📢 Published product`);

      return { success, product }
    } catch (err) {
      log("⚠️ Error creating product en processGroup:", err);
      if (err.body?.errors) {
        log("⚠️ An error occurred:", err?.body.errors || err);
      }
    }
  }
  
  return { success: false, product: null };
}

// ====================== Main sync entrypoint ======================
export async function syncXmlString(admin, xmlString) {
  
  try {
    resetCancelFlag(); // Reinicia el flag de cancelación al inicio
    log("🔄 Starting syncXmlString ...");
    const result = await fetch(xmlString);
    const xml = await result.text();

    const rawItems = parseXmlItems(xml);

    sendProgress({
      type: "sync-start",
      message: "Sincronización iniciada",
      totalProducts: rawItems.length,
    });

    const normalized = rawItems.map(normalizeFeedItem);
    const groups = groupByModelKey(normalized);

    sendProgress({
      type: "groups-detected",
      totalGroups: Object.keys(groups).length
    });

    const results = {};
    for (const [groupId, groupItems] of Object.entries(groups)) {
      if (wasCancelled()) {
        log("🛑 Sincronización cancelada por el usuario.");
        sendProgress({ type: "sync-cancelled", message: "Sincronización cancelada" });
        break;
      }
      try {
        sendProgress({
          type: "group-start",
          groupId
        });

        results[groupId] = await processGroup(admin, groupId, groupItems);

        sendProgress({
          type: "group-end",
          groupId,
          result: results[groupId]
        });
      } catch (err) {
        log("❌ Error processing group", groupId, err);
        results[groupId] = { success: false, error: err?.message || String(err) };

        sendProgress({
          type: "group-error",
          groupId,
          error: err?.message || String(err)
        });
      }
    }

    sendProgress({
      type: wasCancelled() ? "sync-cancelled" : "sync-end",
      results
    });
    log(wasCancelled() ? "🛑 sync cancelled" : "✅ sync finished");
  } catch (err) {
    log("❌ syncXmlString error:", err);
    sendProgress({ step: "sync-error", error: err?.message || String(err) });
    throw err;
  }
}

// ====================== End ======================
