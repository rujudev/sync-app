// xml-sync.server.js
// Reescrito: parser XML -> agrupar por item_group_id -> crear/actualizar producto + variantes
// Incluye: withRetry, media upload (productCreateMedia), búsqueda por item_group_id/handle,
// eventos SSE (attachSendProgress/sendProgress), logs detallados y procesamiento paralelo.

import { XMLParser } from "fast-xml-parser";
import { COLORS } from '../constants/colors.js';
import { MODELS } from '../constants/models.js';
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

export const CONFIG = { LOG: true, RETRIES: 3, RETRY_BASE_DELAY_MS: 200 };
export const log = (...args) => CONFIG.LOG && console.log(new Date().toISOString(), ...args);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let _sendProgress = null;
export function attachSendProgress(fn) {
  _sendProgress = fn;
}

function sendProgress(event) {
  if (_sendProgress) {
    try { _sendProgress(event); } catch (e) { console.warn("sendProgress failed", e); }
  }
}

const xmlParser = new XMLParser({ ignoreAttributes: false });

function parseXmlItems(xmlString) {
  const json = xmlParser.parse(xmlString);
  const items = json?.rss?.channel?.item || [];
  return Array.isArray(items) ? items : [items];
}

function normalizeText(s = "") {
  return String(s || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "") // quita acentos
    .replace(/[^\w\s-]/g, " ") // reemplaza símbolos por espacio
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function extractModelTitle(title = "", brand = "") {
  if (!title) return brand || "";

  let t = title.trim();

  // 1) Quitar paréntesis
  t = t.replace(/\([^)]*\)/g, " ");

  // 2) Quitar capacidades
  t = t.replace(/\b\d{1,4}\s?(gb|tb)\b/gi, " ");

  // 3) Quitar colores reales detectados
  const sortedColors = [...COLORS].sort((a, b) => b.length - a.length);
  for (const col of sortedColors) {
    t = t.replace(
      new RegExp(`\\b${col.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "ig"),
      " "
    );
  }

  // 4) Expandir sufijos pegados al número (S25FE → S25 FE)
  MODELS.forEach(suf => {
    t = t.replace(new RegExp(`(\\d)(${suf})`, "i"), "$1 $2");
  });

  // 5) Normalizar espacios
  t = t.replace(/\s+/g, " ").trim();

  // 6) Capitalizar
  t = t
    .split(" ")
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");

  // 7) Añadir marca si no está al principio
  if (brand) {
    const b = brand.toLowerCase();
    if (!t.toLowerCase().startsWith(b + " ")) {
      t = `${brand} ${t}`;
    }
  }

  return t;
}

function computeModelKey(title, brand) {
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
    description: (get("description") || "").replace(/Cosladafon/gi, "Secondtech"),
    brand,
    capacity: capacityMatch ? capacityMatch[1].toUpperCase() : "Estándar",
    // color: (colorFinal || "Sin color").toLowerCase(),
    color: get("color").toLowerCase(),
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

    if (edges.length > 0) {
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

  log("Building Shopify product for model:", { ...group });

  const CONDITION = {
    new: "nuevo",
    refurbished: "reacondicionado",
    used: "usado"
  }

  const title = base.modelTitle;
  
  const capacities = uniqStrings(group.map(v => v.capacity ));
  const colors = uniqStrings(group.map(v => v.color));
  const conditions = uniqStrings(group.map(v => v.condition));
  
  const so = base.brand.toLowerCase() !== 'apple' ? 'Android' : 'Apple';

  const tags = [
    base.brand.toLowerCase(),
    so.toLowerCase(),
  ]

  const images = uniqStrings(group.map(v => v.image)).map(src => ({ originalSrc: src }));

  const variants = group.map((v) => ({
    sku: v.sku,
    barcode: String(v.gtin) || null,
    price: v.price != null ? Number(v.price).toFixed(2) : "0.00",
    inventoryPolicy: "CONTINUE",
    optionValues: [
      { optionName: "Capacidad", name: v.capacity },
      { optionName: "Color", name: v.color },
      { optionName: "Condición", name: CONDITION[v.condition] || v.condition },
    ],
    image: v.image || null
  }));

  return {
    title,
    tags,
    vendor: "Cosladafon",
    descriptionHtml: base.description || "",
    productOptions: [
      { name: "Capacidad", values: capacities.map(c => ({ name: c })) },
      { name: "Color", values: colors.map(c => ({ name: c })) },
      { name: "Condición", values: conditions.map(c => ({ name: CONDITION[c] || c })) }
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

function variantNeedsUpdate(existingVar, newVar) {
  if (existingVar.price !== newVar.price) return true;
  if (existingVar.sku !== newVar.sku) return true;
  if (existingVar.barcode !== newVar.barcode) return true;

  const newOpts = newVar.optionValues.map(o => `${o.optionName}:${o.name}`).join("|");
  const existOpts = existingVar.selectedOptions.map(o => `${o.name}:${o.value}`).join("|");

  return newOpts !== existOpts;
}

// ====================== Create Product (with handle & tags & media) ======================
async function createShopifyProduct(admin, productObj, groupId = null) {
  // build input, include handle & tag for future searches
  const input = { ...productObj };
  
  if (groupId) {
    const handle = String(groupId).toLowerCase().replace(/[^\w\s-]/g, "").replace(/\s+/g, "-").slice(0, 80);
    input.handle = handle;
  }

  sendProgress({ step: "product-create-request", title: input.title, groupId });

  try {
    sendProgress({
      type: "product-create-request",
      title: input.title,
      groupId
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

async function syncExistingProduct(admin, existing, productObj, groupId = null) {
  let created = 0;
  let updated = 0;

  sendProgress({
    type: "variants-sync-start",
    productId: existing.id,
    groupId
  });

  let imageMap = {};

  // If productObj has images, try to upload them (won't automatically link to variants here)
  if (productObj.images && productObj.images.length) {
    try {
      const media = productObj.images.map((img, i) => ({
        mediaContentType: "IMAGE",
        originalSource: img.originalSrc,
        alt: `${productObj.title} - ${i + 1}`
      }));
      
      await adminGraphql(admin, PRODUCT_CREATE_MEDIA, { media, product: { id: existing.id } });
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
    
    try {
      const variantsCreateRes = await adminGraphql(admin, VARIANTS_CREATE, {
        productId: existing.id,
        variants: converted
      });
  
      const variantsData = await variantsCreateRes.json();

      if (variantsData?.data?.productVariantsBulkCreate?.userErrors?.length) {
        log("⚠️ Variant creation errors:", variantsData.data.productVariantsBulkCreate.userErrors);
      } else {
        created += converted.length;
      }
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
      updated += converted.length;
    }
  }

  return { created, updated };
}

async function processGroup(admin, groupId, groupItems) {
  sendProgress({
    type: "processing-group",
    groupId,
    count: groupItems.length
  });

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

      const synced = await syncExistingProduct(admin, { id: product.id }, productObj, groupId);

      sendProgress({ step: "group-updated", groupId, result: synced });

     await adminGraphql(admin, PUBLISH_PRODUCT, {
        id: product.id,
        input: publicationsIDs
      });
  
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
      groups
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
