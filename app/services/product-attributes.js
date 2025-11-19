// app/services/product-attributes.js
// Helpers para extraer atributos y agrupar productos por variantes

import { log } from "./xml-sync.server";

/**
 * Extrae capacidad, color y traducción del color desde el título.
 * Ejemplo: "Samsung Galaxy S23 Ultra 512Gb Sky Blue (Azul)"
 * @param {string} title
 * @returns {{capacity: string, color: string, colorTranslation: string}}
 */
export function extractAttributesFromTitle(title) {
  // Capacidad: busca patrones como 256GB, 256 GB, 512Gb, 1TB, etc.
  const capacityMatch = title.match(/(\d{2,4}\s?(GB|TB|Gb|Tb))/i);
  // Color: texto entre la capacidad y el paréntesis
  let color = '';
  if (capacityMatch) {
    // Busca desde el final de la capacidad hasta el paréntesis
    const afterCapacity = title.split(capacityMatch[0])[1];
    if (afterCapacity) {
      const colorMatch = afterCapacity.match(/([^()]+) \(/);
      if (colorMatch) {
        color = colorMatch[1].trim();
      } else {
        // Si no hay paréntesis, toma el texto hasta el final
        color = afterCapacity.trim();
      }
    }
  }
  // Traducción del color: lo que está dentro del paréntesis
  const colorTranslationMatch = title.match(/\(([^)]+)\)/);
  return {
    capacity: capacityMatch ? capacityMatch[1] : '',
    color,
    colorTranslation: colorTranslationMatch ? colorTranslationMatch[1].trim() : '',
  };
}

/**
 * Extrae el modelo del título (todo lo anterior a la capacidad)
 * @param {string} title
 * @returns {string}
 */
export function extractModel(title) {
  const modelMatch = title.match(/^(.*?)(\d{2,4}\s?(GB|TB|Gb|Tb))/i);
  return modelMatch ? modelMatch[1].trim() : title;
}

/**
 * Normaliza productos con los atributos extraídos
 * @param {Array} productos
 * @returns {Array}
 */
export function normalizeProductsWithAttributes(productos) {
  return productos.map(p => {
    const attrs = extractAttributesFromTitle(p.title);
    return {
      ...p,
      model: extractModel(p.title),
      capacity: attrs.capacity,
      color: attrs.color,
      colorTranslation: attrs.colorTranslation,
    };
  });
}

/**
 * Agrupa productos por modelo, capacidad y color
 * @param {Array} productos
 * @returns {Array<Array>}
 */
export function groupByModelCapacityColor(productos) {
  const groups = {};
  productos.forEach(p => {
    const key = `${p.model}|${p.capacity}|${p.color}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push(p);
  });
  return Object.values(groups);
}

function mapAvailability(av) {
  const a = av?.toLowerCase();
  if (a === "in_stock" || a === "available")
    return { status: "active", inventoryPolicy: "CONTINUE" };

  if (a === "preorder" || a === "coming_soon" || a === "new")
    return { status: "active", inventoryPolicy: "CONTINUE", tags: ["preorder"] };

  return { status: "draft", inventoryPolicy: "DENY" };
}

export function parseXmlProduct(item) {
  const availabilityInfo = mapAvailability(item["g:availability"]);

  // ============================================
  // SKU: prioridad → GTIN > MPN > g:id
  // ============================================
  const sku = item["g:id"];

  // ============================================
  // TAGS
  // ============================================
  const tags = [];

  // Tags de disponibilidad (preorder)
  if (availabilityInfo.tags) tags.push(...availabilityInfo.tags);

  // Marca
  if (item["g:brand"] && typeof item["g:brand"] === "string") {
    const brandTag = item['g:brand'].toLowerCase() === 'apple' ? 'Apple' : 'Android';

    tags.push(brandTag);
  }

  // Condición → etiquetas normalizadas
  const condition = item["g:condition"]?.toLowerCase();
  if (condition) {
    // tags traducidos
    switch (condition) {
      case "new":
        tags.push("nuevo");
        break;
      case "refurbished":
        tags.push("reacondicionado");
        break;
      case "used":
        tags.push("usado");
        break;

      default:
        tags.push(condition);
    }
  }

  let rawPrice = item["g:price"] || "";
  rawPrice = rawPrice.trim();
  if (rawPrice.includes(" ")) {
    rawPrice = rawPrice.split(" ")[0];
  }
  rawPrice = rawPrice.replace(/,/, ".");
  rawPrice = rawPrice.replace(/[^\d.]/g, "");
  const parts = rawPrice.split('.');
  if (parts.length > 2) {
    rawPrice = parts[0] + '.' + parts.slice(1).join('');
  }
  const price = (!isNaN(parseFloat(rawPrice)) && parseFloat(rawPrice) > 0) ? parseFloat(rawPrice) : null;

  log(`Parsed price: "${item["g:price"]}" -> ${price}`);
  // ============================================
  // Producto normalizado
  // ============================================
  return {
    id: item["g:id"] || null,
    title: item["g:title"] || "Producto sin título",
    description: item["g:description"].replace('Cosladafon', 'Secondtech') || "",
    // vendor: item["g:brand"] || "Proveedor",
    vendor: "Cosladafon",
    brand: item["g:brand"] || "",
    condition: item["g:condition"] || "",
    price,
    gtin: item["g:gtin"] || null,
    sku,
    item_group_id: item["g:item_group_id"] || null,
    image_link: item["g:image_link"] || null,
    availability: item["g:availability"] || "unknown",
    color: item["g:color"] || "",
    category: item["g:product_type"] || "",
    tags,
    status: availabilityInfo.status,
    inventoryPolicy: availabilityInfo.inventoryPolicy,
  };
}