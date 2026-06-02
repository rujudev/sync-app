// attributes-utils.js
// Helpers para extraer y normalizar capacidad (ej: 128GB, 1TB)

const CAPACITY_RE = /\b(\d{1,4})\s?(GB|TB)\b/gi;

function pickBestCapacityFromMatches(matches) {
  if (!matches || matches.length === 0) return null;
  return matches.reduce((a, b) => (a.valueGB >= b.valueGB ? a : b));
}

export function extractColorFromTitle(title = "") {
  if (!title) return null;
  
  // Captura lo dentro del último paréntesis: (Blanco), (Azul), etc.
  const match = title.match(/\(([^)]+)\)\s*$/);
  
  if (!match || !match[1]) return null;
  
  const colorText = match[1].trim();
  
  // Validar que no sea un modelo (ej: "A127F", "SM-721B", etc.)
  const isModelNumber = /^[A-Z0-9\-]+$/.test(colorText);
  if (isModelNumber) return null;
  
  // Normalizar: "Azul Oscuro" → "azul oscuro"
  return colorText.toLowerCase();
}

export function extractCapacityFromString(s = "") {
  if (!s) return null;
  const matches = [];
  let m;
  while ((m = CAPACITY_RE.exec(String(s)))) {
    const n = parseInt(m[1].replace(/\D/g, ""), 10);
    const unit = (m[2] || "GB").toUpperCase();
    const valueGB = unit === "TB" ? n * 1024 : n;
    matches.push({ n, unit, valueGB });
  }
  if (matches.length === 0) return null;
  const best = pickBestCapacityFromMatches(matches);
  // Devuelve formato consistente: ejemplo "128GB" o "1TB"
  return `${best.n}${best.unit}`;
}

function extractBaseName(url = "") {
  try {
    const file = String(url || "").split("/").pop() || "";
    return file.split(".")[0] || "";
  } catch (e) {
    return "";
  }
}

export function extractCapacity({ title = "", sku = "", image = "", description = "" } = {}) {
  // 1) Priorizar título
  let c = extractCapacityFromString(title);
  if (c) return c;

  // 2) Intentar con SKU
  c = extractCapacityFromString(sku);
  if (c) return c;

  // 3) Intentar con base del nombre de imagen
  try {
    const base = image ? extractBaseName(image) : "";
    c = extractCapacityFromString(base);
    if (c) return c;
  } catch (e) { /* ignore */ }

  // 4) Intentar con descripción
  c = extractCapacityFromString(description);
  if (c) return c;

  // 5) Fallback: null (caller decide si usa "Estándar")
  return null;
}

export default { extractCapacityFromString, extractCapacity, extractColorFromTitle };
