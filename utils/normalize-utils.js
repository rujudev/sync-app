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

// Elimina enlaces de YouTube de un texto HTML. El feed usa varios formatos:
//   1) Bloque correcto:  [youtube]https://...[/youtube]
//   2) Malformado:        youtube]https://...[/youtube]   (falta el "[" inicial)
//   3) URL suelta:        https://www.youtube.com/watch?v=...  (sin etiquetas)
// Se cubren los tres para que ninguna variante llegue a la descripción del
// producto en Shopify.
export function removeYouTubeTags(text) {
  if (!text) return text;
  return text
    // 1) Bloques completos [youtube]...[/youtube]
    .replace(/\[youtube\][\s\S]*?\[\/youtube\]/gi, '')
    // 2) URLs de YouTube sueltas (se detienen antes de un espacio, "[" o "<",
    //    por lo que también limpian el caso malformado "youtube]https://...")
    .replace(/https?:\/\/(?:www\.)?(?:youtube\.com|youtu\.be)\/[^\s\[<]+/gi, '')
    // 3) Etiquetas residuales o malformadas: [youtube], [/youtube], "youtube]"
    .replace(/\[?\/?youtube\]/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
