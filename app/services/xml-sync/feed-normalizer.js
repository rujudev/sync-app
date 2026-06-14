// feed-normalizer.js
// Convierte los items crudos del feed XML en objetos normalizados y los
// agrupa por modelo para crear un producto Shopify por modelo real.

import { COLORS } from '../../constants/colors.js';
import { FORBIDDEN_MODEL_WORDS } from '../../constants/forbidden-words.js';
import { MODELS } from '../../constants/models.js';
import { extractCapacity, extractColorFromTitle } from '../../../utils/attributes-utils.js';
import { normalizeText, normalizeString, normalizeBrand } from '../../../utils/normalize-utils.js';

// Extrae el título del modelo limpiando capacidad, color, condición y
// códigos de modelo del título original del feed.
export function extractModelTitle(title = "", brand = "") {
  if (!title) return brand || "";

  let t = title.trim();

  // Reemplazar paréntesis con números por su contenido sin paréntesis
  t = t.replace(/\(\s*([0-9]+)\s*\)/g, " $1 ");

  // 1) Quitar paréntesis
  t = t.replace(/\([^)]*\)/g, " ");

  // 2) Quitar capacidades
  t = t.replace(/\b\d{1,4}\s?(gb|tb)\b/gi, " ");

  // 3) Quitar colores
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

  // 4) Fixes de typos habituales en el feed
  t = t.replace(/\bgalax\s*y\b/gi, "galaxy");
  t = t.replace(/\bgalazy\b/gi, "galaxy");

  // 4C) Normalizar Flip/Fold con número
  t = t.replace(/\bz\s*flip\s*([0-9])\b/gi, "Z Flip$1");
  t = t.replace(/\bflip\s*([0-9])\b/gi, "Flip$1");
  t = t.replace(/\bz\s*fold\s*([0-9])\b/gi, "Z Fold$1");
  t = t.replace(/\bfold\s*([0-9])\b/gi, "Fold$1");

  // 4E) Normalizar FE pegado (flip7FE → flip7 FE)
  t = t.replace(/(Flip|Fold)(\d+)\s*fe/i, "$1$2 FE");

  // 5) Eliminar códigos Samsung SM-XXXX
  t = t.replace(/\bsm[-\s]?[a-z0-9]{3,7}\b/gi, " ");

  // 6) Eliminar códigos tipo G975F, S901B
  t = t.replace(/\b[gsaf][0-9]{3,5}[a-z]{1,3}\b/gi, " ");

  // 7) Eliminar capacidades sueltas
  t = t.replace(/\b(128|256|512|1024)\b/gi, " ");

  // 8) Expandir sufijos pegados al número (S25FE → S25 FE)
  let tCheck = String(t || "").toLowerCase();
  const sortedModels = [...MODELS].sort((a, b) => b.length - a.length);
  for (const suf of sortedModels) {
    const sufEsc = suf.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`\\d${sufEsc}\\b`, "i").test(tCheck)) {
      const rx = new RegExp(`(\\d)(${sufEsc})\\b`, "ig");
      t = t.replace(rx, "$1 $2");
      tCheck = String(t || "").toLowerCase();
    }
  }

  // 9-12) Limpieza final
  t = t.replace(/\s+/g, " ").trim();
  t = t.replace(/(\w)\s*\+\s*/g, "$1+");
  t = t.replace(/\s*[345]\s?g.*$/i, "");
  t = t.replace(/\b(dual sim|single sim|doble sim|ds|duos)\b.*$/i, "");

  // 13) Capitalizar
  t = t.split(" ").map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(" ");

  // 14) Ajustar prefijo de marca
  if (brand) {
    const b = normalizeBrand(brand);
    if (b === "apple") {
      t = t.replace(/^apple\s+/i, "").trim();
    } else if (!t.toLowerCase().startsWith(b + " ")) {
      t = `${String(brand).trim()} ${t}`.trim();
    }
  }

  return t;
}

export function computeModelKey(title, brand) {
  return normalizeText(extractModelTitle(title, brand));
}

// Devuelve la primera descripción no vacía del grupo.
export function pickGroupDescription(group = []) {
  return group.map((item) => String(item?.description || "").trim()).find(Boolean) || "";
}

// Convierte un item crudo del feed en un objeto normalizado listo para agrupar.
export function normalizeFeedItem(item) {
  const get = (f) => item[`g:${f}`] ?? item[f] ?? "";

  const id = String(get("id") || "");
  if (id.includes("TEST")) return null;

  const title = String(get("title") || "");
  const brand = String(get("brand") || "").trim();

  // ── CAMBIO 1 ── Normalizar títulos donde el número y GB/TB van pegados
  // a la siguiente palabra (ej: "256GBCrafted" → "256GB Crafted").
  // Sin este paso, extractCapacity no detecta la capacidad y devuelve null.
  const normalizedTitle = title.replace(/(\d)(GB|TB)([A-Za-z])/gi, "$1$2 $3");

  const rawCapacity = extractCapacity({
    title: normalizedTitle,
    sku: get("id"),
    image: get("image_link"),
    description: get("description")
  });

  const capacity = rawCapacity
    ? String(rawCapacity).toUpperCase().replace(/\s+/g, "")
    : null;

  let modelTitle = extractModelTitle(title, brand);
  let modelKey = computeModelKey(title, brand);

  const colorFromTitle = extractColorFromTitle(title);
  const color = colorFromTitle || normalizeString(get("color"));

  // Tratar sufijo "FE" como parte del modelo para no agruparlo con el base
  const hasFESuffix = /\bFE\b/i.test(title);
  if (hasFESuffix) {
    if (!/\bFE\b/i.test(modelTitle)) modelTitle = `${modelTitle} FE`;
    if (!modelKey.split(/\s+/).includes('fe')) modelKey = `${modelKey} fe`;
  }

  // ── NUEVO ── Descartar items con availability = "out_of_stock" antes de
  // normalizar el resto de campos. El feed puede incluir SKUs agotados que
  // no deben crear variantes en Shopify ni aparecer en ningún grupo.
  // Se comprueba aquí, en el origen del pipeline, para que ningún módulo
  // posterior (product-builder, sync-engine) tenga que conocer esta regla.
  // El valor se normaliza a minúsculas para cubrir variantes del feed como
  // "Out_Of_Stock", "OUT OF STOCK", etc.
  const availability = String(get("availability") || "").trim().toLowerCase().replace(/[\s_]/g, "");
  if (availability === "outofstock") return null;

  let priceRaw = String(get("sale_price") || "").trim();
  priceRaw = priceRaw.split(" ")[0].replace(",", ".").replace(/[^\d.]/g, "");

  return {
    sku: String(get("id") || ""),
    groupId: get("item_group_id") || null,
    title,
    modelTitle,
    modelKey,
    description: (get("description") || "").replace(/Cosladafon/gi, "Secondtech"),
    brand,
    capacity,
    color,
    condition: (get("condition") || "new").toLowerCase(),
    price: parseFloat(priceRaw),
    image: get("image_link") || null,
    gtin: get("gtin") || null,
    availability: availability || null,
    raw: item
  };
}

// ── CAMBIO 2 ── Agrupa items por modelKey (nombre limpio del modelo)
// en lugar de item_group_id (GTIN), que varía por capacidad y fragmenta
// el mismo modelo en grupos distintos (ej: Xiaomi 17T 256GB y 512GB
// quedaban en 2 grupos separados). Ahora todas las capacidades, colores
// y condiciones de un mismo modelo se unen en un solo grupo/producto.
export function groupByModelKey(items) {
  const groups = {};
  for (const item of items) {
    const key = item.modelKey || normalizeText(item.title);
    if (!groups[key]) groups[key] = [];
    groups[key].push(item);
  }
  return groups;
}