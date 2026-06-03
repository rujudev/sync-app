// normalize-utils.js
// Funciones puras de normalización de strings, sin estado ni I/O.
// Son las más reutilizables y las primeras que se deben testear unitariamente.

// Elimina acentos, símbolos y normaliza espacios a minúsculas.
export function normalizeText(s = "") {
  return String(s || "").normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w\s-+]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// Normaliza a string trimado en minúsculas.
export function normalizeString(value) {
  return String(value || "").trim().toLowerCase();
}

// Normaliza el nombre de marca a minúsculas.
export function normalizeBrand(brand = "") {
  return String(brand || "").trim().toLowerCase();
}

// Normaliza un campo de texto (trim sin cambiar case).
export function normalizeTextField(v) {
  return String(v || "").trim();
}

// Normaliza un array de tags a minúsculas ordenadas.
export function normalizeTags(tags = []) {
  return (Array.isArray(tags) ? tags : [])
    .map((t) => String(t || "").trim().toLowerCase())
    .filter(Boolean)
    .sort();
}

// Devuelve un array de strings únicos, filtrando vacíos.
export function uniqStrings(arr = []) {
  return Array.from(new Set(arr.filter(Boolean).map(s => String(s).trim())));
}

// Comprueba si un valor es un identificador usable (no nulo ni placeholder).
export function isUsableIdentifier(value) {
  const v = String(value || "").trim();
  if (!v) return false;
  const invalid = ["null", "undefined", "n/a", "na", "-"];
  return !invalid.includes(v.toLowerCase());
}

// Elimina etiquetas [youtube]...[/youtube] de un texto HTML.
export function removeYouTubeTags(text) {
  if (!text) return text;
  return text.replace(/\[youtube\][\s\S]*?\[\/youtube\]/gi, '').replace(/\s{2,}/g, ' ').trim();
}
