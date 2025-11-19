// Test de agrupamiento y parseo de productos.xml
import { XMLParser } from 'fast-xml-parser';
import fs from 'fs';

// --- Copia directa de las funciones necesarias ---
function parseXmlProduct(item) {
  const availabilityInfo = (item["g:availability"] || '').toLowerCase();
  const sku = item["g:id"];
  const tags = [];
  if (item["g:brand"] && typeof item["g:brand"] === "string") {
    const brandTag = item['g:brand'].toLowerCase() === 'apple' ? 'Apple' : 'Android';
    tags.push(brandTag);
  }
  const condition = item["g:condition"]?.toLowerCase();
  if (condition) tags.push(condition);
  let rawPrice = item["g:price"] || "";
  rawPrice = rawPrice.trim();
  if (rawPrice.includes(" ")) rawPrice = rawPrice.split(" ")[0];
  rawPrice = rawPrice.replace(/,/, ".");
  rawPrice = rawPrice.replace(/[^\d.]/g, "");
  const price = (!isNaN(parseFloat(rawPrice)) && parseFloat(rawPrice) > 0) ? parseFloat(rawPrice) : null;
  return {
    id: item["g:id"] || null,
    title: item["g:title"] || "Producto sin título",
    description: item["g:description"] || "",
    vendor: item["g:brand"] || "Proveedor",
    brand: item["g:brand"] || "",
    model: item["g:model"] || item["g:brand"] || "",
    capacity: item["g:capacity"] || '',
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
    status: availabilityInfo,
    inventoryPolicy: "CONTINUE",
  };
}

function groupProductsByVariants(products) {
  const groups = new Map();
  for (const product of products) {
    // Agrupar por modelo y capacidad
    const model = product.model ? product.model.trim().toLowerCase() : '';
    const capacity = product.capacity ? product.capacity.trim().toUpperCase() : '';
    if (model && capacity) {
      const key = `${model}_${capacity}`;
      if (!groups.has(key)) {
        groups.set(key, []);
      }
      groups.get(key).push(product);
    }
  }
  return groups;
}

async function testAgrupamientoProductosXML(xmlPath) {
  const xml = fs.readFileSync(xmlPath, 'utf8');
  const parser = new XMLParser({ ignoreAttributes: false });
  const parsed = parser.parse(xml);
  const items = parsed?.rss?.channel?.item || [];
  if (!items.length) {
    console.log('⚠️ XML vacío');
    return;
  }
  // Normalizador para extraer modelo, capacidad y color
  function normalizeProductAttributes(product) {
  // Modelo: extraer la primera parte del título antes de la capacidad y normalizar
  const modelMatch = product.title.match(/^(.*?)(\d{2,4}GB|\d{1,4}TB|\d{2,4}G|\d{2,4}M)?/i);
  let rawModel = modelMatch ? modelMatch[1] : product.brand || '';
  // Eliminar espacios, guiones, paréntesis y pasar a minúsculas
  product.model = rawModel.replace(/\s+|\-|\(|\)/g, '').toLowerCase();

    // Capacidad: buscar en el título
    const capacityMatch = product.title.match(/(\d{2,4}GB|\d{1,4}TB|\d{2,4}G|\d{2,4}M)/i);
    product.capacity = capacityMatch ? capacityMatch[1].toUpperCase() : '';

    // Color: buscar en el título o en el campo color
    const colorMatch = product.title.match(/Black|White|Negro|Blanco|Blue|Azul|Red|Rojo|Green|Verde|Gold|Oro|Silver|Plata/i);
    product.color = product.color || (colorMatch ? colorMatch[0] : '');

    return product;
  }

  const products = items.map(item => normalizeProductAttributes(parseXmlProduct(item)));
  const variantGroups = groupProductsByVariants(products);

  console.log(variantGroups)

  console.log(`\n=== RESULTADO AGRUPAMIENTO ===`);
  for (const [groupKey, variants] of variantGroups) {
    // Extraer modelo y capacidad del groupKey
    const [modelo, capacidad] = groupKey.split('_');
    console.log(`\nProducto: ${modelo.toUpperCase()} | Capacidad: ${capacidad}`);
    console.log(`  Variantes (${variants.length}):`);
    // Agrupar variantes por color
    const variantesPorColor = {};
    variants.forEach((v) => {
      const color = v.color || 'Sin color';
      if (!variantesPorColor[color]) variantesPorColor[color] = [];
      variantesPorColor[color].push(v);
    });
    Object.entries(variantesPorColor).forEach(([color, vars]) => {
      console.log(`    Color: ${color}`);
      vars.forEach((v, idx) => {
        console.log(`      [${idx + 1}] Condición: ${v.condition} | SKU: ${v.sku} | Precio: ${v.price}`);
      });
    });
  }
}

// Cambia la ruta al archivo XML según tu estructura
const xmlPath = './productos.xml';
testAgrupamientoProductosXML(xmlPath);
