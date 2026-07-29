// sanitize-html.js
// Saneado del HTML que devuelve la IA antes de que llegue a descriptionHtml
// de Shopify.
//
// Enfoque: whitelist muy corta de etiquetas y eliminación TOTAL de atributos.
// Al no conservar ningún atributo, no hay superficie para href javascript:,
// onerror, style, ni data-*. Es un saneador a base de expresiones regulares,
// aceptable aquí porque la entrada es copy de marketing generado por nosotros
// y la salida no admite un solo atributo. No lo reutilices para HTML de
// terceros sin cambiarlo por una librería real.

const ALLOWED_TAGS = new Set([
  'h2', 'h3', 'h4', 'h5', 'h6',
  'p', 'ul', 'ol', 'li',
  'strong', 'em', 'br',
]);

// Elementos que se eliminan junto con su contenido, no solo la etiqueta.
const DANGEROUS = 'script|style|iframe|object|embed|svg|math|form|input|link|meta';

export function sanitizeDescriptionHtml(raw) {
  if (!raw) return null;

  let html = String(raw);

  // 1) Vallas de código markdown que el modelo cuela a menudo (```html … ```)
  html = html.replace(/```[a-z]*\s*/gi, '').replace(/```/g, '');

  // 2) Comentarios HTML
  html = html.replace(/<!--[\s\S]*?-->/g, '');

  // 3) Elementos peligrosos, con su contenido
  html = html.replace(new RegExp(`<(${DANGEROUS})\\b[\\s\\S]*?<\\/\\1\\s*>`, 'gi'), '');
  //    …y sus etiquetas huérfanas si el bloque venía mal cerrado
  html = html.replace(new RegExp(`<\\/?(?:${DANGEROUS})\\b[^>]*>`, 'gi'), '');

  // 4) Resto de etiquetas: se conservan solo las de la whitelist y se
  //    reescriben SIN ningún atributo. Lo que no esté en la lista se elimina
  //    conservando su texto interior.
  html = html.replace(/<(\/?)\s*([a-z0-9]+)\b[^>]*>/gi, (_m, slash, tag) => {
    const t = String(tag).toLowerCase();
    if (!ALLOWED_TAGS.has(t)) return '';
    if (t === 'br') return '<br>';
    return slash ? `</${t}>` : `<${t}>`;
  });

  // 5) Limpieza de espacios
  html = html.replace(/&nbsp;/gi, ' ').replace(/\s{2,}/g, ' ').trim();

  // 6) Si al quitar las etiquetas no queda texto real, no vale.
  //    Devolver null es lo que impide que se machaque una descripción buena.
  const text = html.replace(/<[^>]+>/g, '').trim();
  if (text.length < 40) return null;

  return html;
}
