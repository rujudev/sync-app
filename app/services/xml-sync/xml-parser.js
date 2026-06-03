// xml-parser.js
// Parsea el XML del feed de Google Shopping y deduplica items por g:id,
// quedándose con el de mayor sale_price cuando hay duplicados.

import { XMLParser } from "fast-xml-parser";

const xmlParser = new XMLParser({ ignoreAttributes: false });

function getNumericPrice(item) {
  const priceRaw = String(item["g:sale_price"] ?? "").trim();
  const cleanPrice = priceRaw.split(" ")[0].replace(",", ".").replace(/[^\d.]/g, "");
  return parseFloat(cleanPrice) || 0;
}

// Parsea el XML y devuelve un array de items deduplicados por g:id.
// Cuando el mismo g:id aparece varias veces, se conserva el de mayor precio.
export function parseXmlItems(xmlString) {
  const json = xmlParser.parse(xmlString);
  const items = json?.rss?.channel?.item || [];
  const rawItemsArray = Array.isArray(items) ? items : [items];

  const uniqueItemsMap = new Map();

  for (const item of rawItemsArray) {
    const id = String(item["g:id"] ?? item["id"] ?? "").trim();

    if (!id) {
      uniqueItemsMap.set(Symbol('empty-id'), item);
      continue;
    }

    const currentPrice = getNumericPrice(item);

    if (uniqueItemsMap.has(id)) {
      const existingPrice = getNumericPrice(uniqueItemsMap.get(id));
      if (currentPrice > existingPrice) {
        uniqueItemsMap.set(id, item);
      }
    } else {
      uniqueItemsMap.set(id, item);
    }
  }

  return Array.from(uniqueItemsMap.values());
}
