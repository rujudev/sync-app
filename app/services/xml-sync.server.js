// xml-sync.server.js
// Reescrito: parser XML -> agrupar por item_group_id -> crear/actualizar producto + variantes
// Incluye: withRetry, media upload (productCreateMedia), búsqueda por item_group_id/handle,
// eventos SSE (attachSendProgress/sendProgress), logs detallados y procesamiento paralelo.

import { XMLParser } from "fast-xml-parser";
import { COLORS } from '../constants/colors.js';
import { FORBIDDEN_MODEL_WORDS } from '../constants/forbidden-words.js';
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

const groupsState = {};
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
    .replace(/[^\w\s-+]/g, " ") // reemplaza símbolos por espacio
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function extractModelTitle(title = "", brand = "") {
  if (!title) return brand || "";

  let t = title.trim();

  // Reemplazar paréntesis que contienen números por su contenido sin paréntesis
  t = t.replace(/\(\s*([0-9]+)\s*\)/g, " $1 ");

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

  // 3B) Quitar palabras prohibidas (aurora, forest, dazzling, beauty...)
  FORBIDDEN_MODEL_WORDS.forEach(w => {
    const rx = new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi");
    t = t.replace(rx, " ");
  });

  // 4) FIX “Galax y”
  t = t.replace(/\bgalax\s*y\b/gi, "galaxy");

  // 4B) FIX “Galazy”
  t = t.replace(/\bgalazy\b/gi, "galaxy");

  // 4C) Normalizar Flip (flip4, flip 4, zflip4, z flip 4, etc.)
  t = t.replace(/\bz\s*flip\s*([0-9])\b/gi, "Z Flip$1");
  t = t.replace(/\bflip\s*([0-9])\b/gi, "Flip$1");

  // 4D) Normalizar Fold (fold4, fold 4, zfold4, z fold 4, etc.)
  t = t.replace(/\bz\s*fold\s*([0-9])\b/gi, "Z Fold$1");
  t = t.replace(/\bfold\s*([0-9])\b/gi, "Fold$1");

  // 4E) Normalizar FE pegado (flip7FE → flip7 FE)
  t = t.replace(/(Flip|Fold)(\d+)\s*fe/i, "$1$2 FE");

  // 5) Eliminar códigos Samsung SM-XXXX, SM XXXX, SMXXXX
  t = t.replace(/\bsm[-\s]?[a-z0-9]{3,7}\b/gi, " ");

  // 6) Eliminar códigos tipo G975F, S901B, F731U, A326B (versión más segura)
  t = t.replace(/\b[gsaf][0-9]{3,5}[a-z]{1,3}\b/gi, " ");

  // 7) Eliminar 128/256/512/1024 sueltos
  t = t.replace(/\b(128|256|512|1024)\b/gi, " ");

  // 8) Expandir sufijos pegados al número (S25FE → S25 FE)
  MODELS.forEach(suf => {
    t = t.replace(new RegExp(`(\\d)(${suf})`, "i"), "$1 $2");
  });

  // 9) Normalizar espacios
  t = t.replace(/\s+/g, " ").trim();

  // 10) Mantener el símbolo "+" en el modelo
  t = t.replace(/(\w)\s*\+\s*/g, "$1+");

  // 11) Eliminar conectividad (3G, 4G, 5G) y todo lo que venga a la derecha
  t = t.replace(/\s*[345]\s?g.*$/i, "");

  // 12) Eliminar especificaciones de SIM
  t = t.replace(/\b(dual sim|single sim|doble sim|ds|duos)\b.*$/i, "");

  // 13) Capitalizar
  t = t
    .split(" ")
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");

  // 14) Añadir marca si no está al principio
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

  const id = String(get("id") || "");

  if (id.includes("TEST")) return null;

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

  const variants = group.map((v) => {
    const variant = {
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
    }

    variant.normalizedOptions = normalizeOptions(variant.optionValues);

    return variant;
  });

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

// ===================================================
// SANEAR VARIANTES PARA GRAPHQL (NO ENVIAR CAMPOS INTERNOS)
// ===================================================
function sanitizeVariantForGraphQL(v) {
  const { normalizedOptions, currentMediaId, image, ...clean } = v;
  return clean;
}

// ===================================================
// NORMALIZACIÓN DE OPCIONES
// ===================================================
function normalizeOptions(arr = []) {
  return arr
    .map(opt => ({
      name: (opt.name || opt.optionName || "").trim().toLowerCase(),
      value: (opt.value || opt.name || "").trim().toLowerCase()
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ====================== Create Product (with handle & tags & media) ======================

// ===================================================
// DETECTAR SI UNA VARIANTE NECESITA ACTUALIZARSE
// ===================================================

function variantNeedsUpdate(existingVar, newVar) {
  const norm = s => String(s || "").trim().toLowerCase();

  if (Number(existingVar.price) !== Number(newVar.price)) return true;
  if (norm(existingVar.sku) !== norm(newVar.sku)) return true;
  if (norm(existingVar.barcode) !== norm(newVar.barcode)) return true;

  if ((existingVar.currentMediaId || null) !== (newVar.mediaId || null)) {
    return true;
  }

  const key = v => JSON.stringify(v.normalizedOptions);
  return key(existingVar) !== key(newVar);
}

async function createShopifyProduct(admin, productObj, groupId = null) {
  // build input, include handle & tag for future searches
  const input = { ...productObj };
  
  if (groupId) {
    const handle = String(groupId).toLowerCase().replace(/[^\w\s-]/g, "").replace(/\s+/g, "-").slice(0, 80);
    input.handle = handle;
  }

  sendProgress({
    type: "product_create_request",
    title: input.title,
    groupId
  });

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
      node?.preview?.image?.url?.includes(base.replace(/\+/g, '_'))
    );

    if (found) {
      map[original] = found.id;
    }
  }

  return map;
}

async function getProductMediaWithRetry(admin, productId, maxRetries = 10, delayMs = 2000) {
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

// ===================================================
// DETECTAR VARIANTES DUPLICADAS
// ===================================================
function isDuplicateVariant(existing, variant) {
  const keys = ["capacidad", "color", "condición"];

  // Convierte optionValues → objeto plano {capacidad: '256gb', color: 'gris espacial', ...}
  const normalizeOptions = variant => {
    const obj = {};

    for (const opt of variant.optionValues || []) {
      const optionKey = (opt.optionName || "").toLowerCase().trim();
      const optionValue = (opt.name || "").toLowerCase().trim();
      obj[optionKey] = optionValue;
    }

    return obj;
  };

  const newObj = normalizeOptions(variant);

  return existing.some(ev => {
    const existingObj = normalizeOptions(ev);

    // comparar solo los keys relevantes
    return keys.every(key => existingObj[key] === newObj[key]);
  });
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
  let uploadedMediaNodes = [];

  // If productObj has images, try to upload them (won't automatically link to variants here)
  if (productObj.images && productObj.images.length) {
    try {
      const media = productObj.images.map((img, i) => ({
        mediaContentType: "IMAGE",
        originalSource: img.originalSrc,
        alt: `${productObj.title} - ${i + 1}`
      }));
      
      await adminGraphql(admin, PRODUCT_CREATE_MEDIA, { media, product: { id: existing.id } });

      sendProgress({
        type: "product_media_uploaded",
        productId: existing.id,
        groupId,
        count: media.length
      });
      
      const newGetProductMediaRes = await getProductMediaWithRetry(admin, existing.id);

      sendProgress({
        type: "product_media_added",
        productId: existing.id,
        groupId
      });

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

  // log(`Imagemap for product ${productObj.title}:`, { ...imageMap });

  const variantsToUpdate = [];
  const variantsToCreate = [];

  const productVariantsRes = await adminGraphql(admin, GET_PRODUCT_VARIANTS, {
    query: `product_id:${existing.id?.split('/').pop()}`
  });
  const productVariantsData = await productVariantsRes.json();
  const productVariants = productVariantsData?.data?.productVariants?.nodes || [];

  productVariants.forEach(v => {
    v.normalizedOptions = normalizeOptions(v.selectedOptions);

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
  })

  groupsState[groupId].totalVariants += productObj.variants.length;
  
  // iterate variants
  for (const variant of productObj.variants) {
    sendProgress({
      type: "variant_processing_start",
      groupId,
      productId: existing.id,
      variant: {
        sku: variant.sku,
        image: variant.image,
        capacity: variant.optionValues.find(ov => ov.optionName.toLowerCase() === 'capacidad')?.name || '',
        color: variant.optionValues.find(ov => ov.optionName.toLowerCase() === 'color')?.name || '',
        condition: variant.optionValues.find(ov => ov.optionName.toLowerCase() === 'condición')?.name || ''
      }
    });

    variant.mediaId = imageMap[variant.image] || null;
    const match = findVariant(productVariants, variant);

    if (match) {
      // Preparamos variante para actualización con opciones normalizadas
      const variantForUpdate = {
        ...variant,
        id: match.id,
        selectedOptions: variant.optionValues,
        normalizedOptions: variant.normalizedOptions
      };

      // Evitar duplicados y detectar cambios reales
      if (
        variantNeedsUpdate(match, variantForUpdate) &&
        !isDuplicateVariant(variantsToUpdate, variantForUpdate)
      ) {
        sendProgress({
          type: "variant_update_detected",
          groupId,
          productId: existing.id,
          variant: {
            sku: variant.sku,
            image: variant.image,
            capacity: variant.optionValues.find(ov => ov.optionName.toLowerCase() === 'capacidad')?.name || '',
            color: variant.optionValues.find(ov => ov.optionName.toLowerCase() === 'color')?.name || '',
            condition: variant.optionValues.find(ov => ov.optionName.toLowerCase() === 'condición')?.name || ''
          }
        });

        variantsToUpdate.push(variantForUpdate);
        continue;
      }
    } else {
      // Evitar crear duplicados en Shopify
      if (!isDuplicateVariant(variantsToCreate, variant)) {
        sendProgress({
          type: "variant_create_detected",
          groupId,
          productId: existing.id,
          variant: {
            sku: variant.sku,
            image: variant.image,
            capacity: variant.optionValues.find(ov => ov.optionName.toLowerCase() === 'capacidad')?.name || '',
            color: variant.optionValues.find(ov => ov.optionName.toLowerCase() === 'color')?.name || '',
            condition: variant.optionValues.find(ov => ov.optionName.toLowerCase() === 'condición')?.name || ''
          }
        });

        variantsToCreate.push(variant);
        continue;
      }
    }

    sendProgress({
      type: "variant_processing_success",
      groupId,
      productId: existing.id,
      action: "skipped",
      variant: {
        sku: variant.sku,
        image: variant.image,
        capacity: variant.optionValues.find(ov => ov.optionName.toLowerCase() === 'capacidad')?.name || '',
        color: variant.optionValues.find(ov => ov.optionName.toLowerCase() === 'color')?.name || '',
        condition: variant.optionValues.find(ov => ov.optionName.toLowerCase() === 'condición')?.name || ''
      }
    });

    groupsState[groupId].processedVariants++;

    if (groupsState[groupId].processedVariants === groupsState[groupId].totalVariants) {
      sendProgress({
        type: groupsState[groupId].hasErrors ? "group_error" : "group_success",
        id: groupId
      });
    }
  }

  if (variantsToCreate.length > 0) {
    sendProgress({
      step: "variants-batch-create",
      productId: existing.id,
      count: variantsToCreate.length,
      groupId
    });
    
    const converted = variantsToCreate.map(v => ({ ...sanitizeVariantForGraphQL(convertVariantForShopify(v, imageMap))}) );

    try {
      const variantsCreateRes = await adminGraphql(admin, VARIANTS_CREATE, {
        productId: existing.id,
        variants: converted
      });
  
      const variantsData = await variantsCreateRes.json();
      const variantsCreateError = variantsData?.data?.productVariantsBulkCreate?.userErrors || [];  
      
      if (variantsCreateError.length) {
        variantsCreateError.forEach((err, index) => {
          sendProgress({
            type: "variant_processing_error",
            groupId,
            productId: existing.id,
            message: err.message || "Error creando variante",
            variant: variantsToCreate[index] || null
          });

          groupsState[groupId].processedVariants++;
          groupsState[groupId].hasErrors = true;

          if (groupsState[groupId].processedVariants === groupsState[groupId].totalVariants) {
            sendProgress({ type: "group_error", id: groupId, error: "Variantes con error" });
          }
        });
      } else {
        for (const v of variantsToCreate) {
          // log('✅ Variante creada:', { ...v });
          sendProgress({
            type: "variant_processing_success",
            groupId,
            productId: existing.id,
            action: "created",
            variant: {
              sku: v.sku,
              image: v.image,
              capacity: v.optionValues.find(ov => ov.optionName.toLowerCase() === 'capacidad')?.name || '',
              color: v.optionValues.find(ov => ov.optionName.toLowerCase() === 'color')?.name || '',
              condition: v.optionValues.find(ov => ov.optionName.toLowerCase() === 'condición')?.name || ''
            }
          });

          groupsState[groupId].processedVariants++;
  
          // Si todas las variantes han finalizado
          if (groupsState[groupId].processedVariants === groupsState[groupId].totalVariants) {
            if (groupsState[groupId].hasErrors) {
              sendProgress({ type: "group_error", id: groupId, error: "Variantes con error" });
            } else {
              sendProgress({ type: "group_success", id: groupId });
            }
          }
        }
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

    const converted = variantsToUpdate.map(v => ({ id: v.id, ...sanitizeVariantForGraphQL(convertVariantForShopify(v, imageMap))}) );

    // log(fr

    try {
      // const resUpdate = await processVariantBatches(admin, existing.id, converted, true);
      const variantsUpdateRes = await adminGraphql(admin, VARIANTS_UPDATE, {
        productId: existing.id,
        variants: converted
      });
      const variantsUpdateData = await variantsUpdateRes.json();
      const variantsUpdateError = variantsUpdateData?.data?.productVariantsBulkUpdate?.userErrors || [];
      
      if (variantsUpdateError.length) {
        variantsUpdateError.forEach((err, index) => {
          sendProgress({
            type: "variant_processing_error",
            groupId,
            productId: existing.id,
            message: err.message || "Error actualizando variante",
            variant: variantsToUpdate[index] || null
          });
        });
      } else {
        // log('ImageMap used for updating variants:', { ...imageMap });

        for (const v of variantsToUpdate) {
          // log('✅ Variante actualizada:', { ...v });
          sendProgress({
            type: "variant_processing_success",
            groupId,
            productId: existing.id,
            action: "updated",
            variant: {
              sku: v.sku,
              image: v.image,
              capacity: v.optionValues.find(ov => ov.optionName.toLowerCase() === 'capacidad')?.name || '',
              color: v.optionValues.find(ov => ov.optionName.toLowerCase() === 'color')?.name || '',
              condition: v.optionValues.find(ov => ov.optionName.toLowerCase() === 'condición')?.name || ''
            }
          });
        }

        updated += converted.length;
      }
    } catch (err) {
      log("⚠️ Error updating variants:", err);
    }
  }

  return { created, updated };
}

async function processGroup(admin, groupId, groupItems) {
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
        type: "product_created",
        groupId,
        result: { success, product }
      });

      const synced = await syncExistingProduct(admin, { id: product.id }, productObj, groupId);

      sendProgress({
        type: "product_synced",
        groupId,
        createdVariants: synced.created,
        updatedVariants: synced.updated
      });

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
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), 3000); // 30 segundos de timeout inicial
    
    const result = await fetch(xmlString, { signal: AbortSignal.timeout(60000) });
    clearTimeout(id);
    
    const xml = await result.text();

    const rawItems = parseXmlItems(xml);

    sendProgress({
      type: "sync-start",
      message: "Sincronización iniciada",
      totalProducts: rawItems.length,
    });

    const normalized = rawItems.map(normalizeFeedItem).filter(Boolean);
    const groups = groupByModelKey(normalized);

    sendProgress({
      type: "groups-detected",
      groups
    });

    sendProgress({
      type: "groups_list",
      groups: Object.keys(groups)
    });

    const results = {};
    let processedGroups = 0;

    for (const [groupId, groupItems] of Object.entries(groups)) {
      if (wasCancelled()) {
        log("🛑 Sincronización cancelada por el usuario.");
        sendProgress({ type: "sync-cancelled", message: "Sincronización cancelada" });
        break;
      }

      try {
        sendProgress({  
          type: "group_start",
          id: groupId,
          items: groupItems
        });

        groupsState[groupId] = {
          totalVariants: 0,
          processedVariants: 0,
          hasErrors: false
        };

        results[groupId] = await processGroup(admin, groupId, groupItems);

        sendProgress({
          type: "group_end",
          id: groupId,
          result: results[groupId]
        });

        processedGroups++;

        sendProgress({
          type: "overall_status",
          processed: processedGroups,
          total: Object.keys(groups).length
        });
        
      } catch (err) {
        log("❌ Error processing group", groupId, err);
        results[groupId] = { success: false, error: err?.message || String(err) };

        sendProgress({
          type: "group_error",
          id: groupId,
          error: err?.message || String(err)
        });
      }
    }

    if (!wasCancelled()) {
      sendProgress({ type: "sync-end", results });
    }
    log(wasCancelled() ? "🛑 sync cancelled" : "✅ sync finished");
  } catch (err) {
    log("❌ syncXmlString error:", err);
    sendProgress({ step: "sync-error", error: err?.message || String(err) });
    syncXmlString(admin, xmlString); // reintentar
  }
}

// ====================== End ======================
