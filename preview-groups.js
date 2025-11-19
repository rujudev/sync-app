import { XMLParser } from "fast-xml-parser";
import fs from "fs";

// ====== Helpers (idénticos a los del código final) ======

function normalizeText(s = "") {
  return String(s || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function extractModelTitle(title = "", brand = "") {
  if (!title) return (brand || "").trim();
  let t = String(title);

  t = t.replace(/\([^)]+\)/g, " ");        // paréntesis
  t = t.replace(/\b\d{1,4}\s?(GB|TB)\b/ig, " "); // capacidad
  t = t.replace(/\b(negro|azul|gris|rojo|blanco|verde|amarillo|morado|rosa|plateado|crema|naranja|violeta|grafito|gold|silver|pink|black|white)\b/ig, " "); // colores
  t = t.replace(/\b[Ss]\w{2,}-?\w*\b/g, " "); // códigos SKU tipo G975F
  t = t.replace(/\s+/g, " ").trim();

  if (brand && !new RegExp(brand, "i").test(t)) {
    t = `${brand} ${t}`;
  }

  return t
    .split(" ")
    .filter(Boolean)
    .map(w => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

function computeModelKey(title, brand) {
  return normalizeText(extractModelTitle(title, brand));
}

function uniqStrings(arr = []) {
  return Array.from(new Set(arr.filter(Boolean).map(s => String(s).trim())));
}

// ====== XML Parse ======

const xmlParser = new XMLParser({ ignoreAttributes: false });

function parseXmlItems(xmlString) {
  const json = xmlParser.parse(xmlString);
  const items = json?.rss?.channel?.item || [];
  return Array.isArray(items) ? items : [items];
}

function normalizeFeedItem(item) {
  const get = (f) => item[`g:${f}`] ?? item[f] ?? "";

  const title = String(get("title") || "");
  const brand = String(get("brand") || "");

  const capacityMatch = title.match(/(\d{1,4}GB|\d{1,4}TB)/i);
  const colorMatch = get("color") || (title.match(/negro|azul|gris|rojo|blanco|verde|amarillo|morado|rosa|plateado|crema|naranja|violeta|grafito/i) || [""])[0];

  return {
    id: get("id"),
    title,
    brand,
    modelTitle: extractModelTitle(title, brand),
    modelKey: computeModelKey(title, brand),
    capacity: capacityMatch ? capacityMatch[1].toUpperCase() : "Estándar",
    color: (colorMatch || "Sin color").toLowerCase(),
    condition: (get("condition") || "new").toLowerCase(),
    image: get("image_link"),
  };
}

function groupByModelKey(items) {
  const groups = {};
  for (const item of items) {
    const key = item.modelKey;
    if (!groups[key]) groups[key] = [];
    groups[key].push(item);
  }
  return groups;
}

// ====== Main ======

const xml = fs.readFileSync("./productos.xml", "utf8");
const rawItems = parseXmlItems(xml);
const normalized = rawItems.map(normalizeFeedItem);
const groups = groupByModelKey(normalized);

console.log("===== MODELOS DETECTADOS =====");
console.log(Object.keys(groups).length, "modelos\n");

for (const [modelKey, group] of Object.entries(groups)) {
  console.log("📌 Modelo:", group[0].modelTitle);
  console.log("key:", modelKey);
  console.log("Variantes:");
  group.forEach(v =>
    console.log(`  - ${v.capacity} / ${v.color} / ${v.condition} (SKU ${v.id})`)
  );
  console.log("----\n");
}
