// app/services/product-attributes.js
// Helpers para extraer atributos y agrupar productos por variantes

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