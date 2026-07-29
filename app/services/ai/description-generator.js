// description-generator.js
// Genera la descripción de producto a partir del texto que envía el proveedor.
//
// La IA NO inventa nada: su trabajo es extraer del texto de origen cuatro
// características (pantalla, batería, procesador y cámaras) y escribir una
// frase persuasiva. Lo que no aparezca en el origen, se omite.
//
// Devuelve datos estructurados en JSON y el HTML se construye aquí, en código.
// Así el marcado es válido por construcción, idéntico en todos los productos y
// con la jerarquía de encabezados bajo nuestro control. Pedirle HTML al modelo
// es lo que produce etiquetas mal cerradas y estructuras inconsistentes.

import { createHash } from 'crypto';
import prisma from '../../db.server.js';
import { logger } from '../config.js';
import { sendProgress } from '../progress.js';
import { callJson, isEnabled } from './gemini-client.js';
import { sanitizeDescriptionHtml } from './sanitize-html.js';

// Súbela para regenerar todo el catálogo a propósito tras cambiar el estilo,
// el orden de los bloques o las specs que se extraen.
export const PROMPT_VERSION = 2;

// Longitud mínima del texto del proveedor para que merezca la pena llamar a la
// IA. Por debajo no hay specs que extraer.
const MIN_SOURCE_LENGTH = 200;

const SYSTEM_INSTRUCTION = `
Extraes características técnicas de descripciones de móviles y tablets escritas
por un proveedor mayorista, para una tienda española de dispositivos
reacondicionados.

TU ÚNICA FUENTE ES EL TEXTO QUE RECIBES. No conoces el dispositivo, no puedes
consultar nada y no debes recordar nada sobre él. Si un dato no está
literalmente en ese texto, devuelves cadena vacía para ese campo. Inventar una
cifra es el peor error posible: son fichas de una tienda real y un dato falso
es un problema legal.

CAMPOS A EXTRAER (cadena vacía si no aparece en el texto):

- pantalla:   tamaño, tecnología y tasa de refresco si están.
              Ej: "6,8 pulgadas Dynamic AMOLED 2X, Quad HD+, 120 Hz"
- bateria:    capacidad y tipo de carga si están.
              Ej: "5.000 mAh con carga rápida e inalámbrica"
- procesador: nombre del chip tal cual aparece. Puedes añadir la RAM si el
              texto la menciona. Ej: "Snapdragon 8 Gen 2, hasta 12 GB de RAM"
- camaras:    resolución de la principal y otras ópticas si aparecen.
              Ej: "Principal de 200 MP con zoom óptico y estabilización"

REGLAS PARA LOS CAMPOS:
- Copia las cifras EXACTAMENTE como están en el origen. No redondees, no
  conviertas unidades, no completes con lo que "suele llevar" ese modelo.
- Frases cortas, sin punto final, sin repetir el nombre del campo dentro del
  valor (no escribas "Pantalla: 6,8 pulgadas", solo "6,8 pulgadas...").
- Si el texto menciona el dato de forma vaga y sin cifras ("gran pantalla",
  "buena batería"), devuelve cadena vacía: no aporta nada.
- No incluyas almacenamiento ni capacidades: son variantes de la ficha.

CAMPO "frase":
- 2 o 3 líneas, máximo 300 caracteres, en español de España, tuteando.
- Persuasiva y diferenciadora: para quién es el equipo y por qué merece la pena.
- Menciona el nombre del modelo UNA vez, de forma natural.
- Puede apoyarse en lo que dice el texto de origen, pero SIN repetir las cifras
  ya listadas en los campos anteriores.
- Prohibido mencionar: precio, garantía, plazos de envío, estado o condición del
  producto, colores, capacidades y estado de la batería. Todo eso se añade
  aparte en la ficha y se duplicaría.
- Nada de superlativos vacíos ("increíble", "no te dejará indiferente").

Devuelve solo el JSON del esquema, sin explicaciones y sin marcado HTML.
`.trim();

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    pantalla:   { type: 'STRING' },
    bateria:    { type: 'STRING' },
    procesador: { type: 'STRING' },
    camaras:    { type: 'STRING' },
    frase:      { type: 'STRING' },
  },
  required: ['pantalla', 'bateria', 'procesador', 'camaras', 'frase'],
};

// Hash del texto de origen: si el proveedor cambia su descripción, se regenera.
const hashSource = (text) =>
  createHash('sha256').update(String(text || '')).digest('hex').slice(0, 32);

// El contenido de los campos es texto plano del modelo y va incrustado en HTML.
// Escaparlo garantiza marcado válido aunque venga con &, < o comillas.
const escapeHtml = (s) =>
  String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

// Un valor sirve si tiene sustancia. Descarta los "no disponible" y variantes
// que el modelo cuela a veces en lugar de la cadena vacía que se le pide.
const esValorUtil = (v) => {
  const t = String(v || '').trim();
  if (t.length < 3 || t.length > 200) return false;
  return !/^(n\/?a|no|ninguno|no disponible|no especificad|desconocid|sin dato)/i.test(t);
};

// Construye el HTML de los bloques 1 y 2. El bloque 3 (texto común de
// SecondTech) lo añade buildDescriptionHtml en product-builder.
//
// Notas de SEO y accesibilidad:
//   - Se usa <h6>, el mismo nivel que emplea REFURBISHED_LEGAL_NOTICE_HTML en
//     product-builder, para que toda la descripción sea coherente. El nivel del
//     encabezado apenas influye en SEO (lo que cuenta es que el texto sea
//     descriptivo e incluya el modelo); mezclar niveles distintos dentro de la
//     misma ficha sí sería peor.
//   - Lista con <strong> para la etiqueta: legible para el usuario, escaneable
//     por el buscador y compatible con cualquier tema de Shopify.
//   - Sin atributos, sin estilos en línea y sin clases: el tema es quien manda.
function construirHtml(datos, modelTitle) {
  const specs = [
    ['Pantalla',   datos.pantalla],
    ['Batería',    datos.bateria],
    ['Procesador', datos.procesador],
    ['Cámaras',    datos.camaras],
  ].filter(([, v]) => esValorUtil(v));

  const partes = [];

  if (specs.length) {
    partes.push(`<h6>Características principales del ${escapeHtml(modelTitle)}</h6>`);
    partes.push('<ul>');
    for (const [etiqueta, valor] of specs) {
      partes.push(`<li><strong>${etiqueta}:</strong> ${escapeHtml(String(valor).trim())}</li>`);
    }
    partes.push('</ul>');
  }

  const frase = String(datos.frase || '').trim();
  if (frase.length >= 40) {
    partes.push(`<p>${escapeHtml(frase)}</p>`);
  }

  // Sin specs y sin frase no hay nada que publicar.
  if (!specs.length && frase.length < 40) return null;

  return partes.join('\n');
}

async function generarDatos(modelTitle, brand, sourceDescription) {
  const prompt =
    `Modelo: ${modelTitle}${brand ? ` (marca: ${brand})` : ''}\n\n` +
    `Descripción del proveedor de la que debes extraer los datos:\n` +
    `"""\n${String(sourceDescription).slice(0, 6000)}\n"""`;

  return callJson(prompt, RESPONSE_SCHEMA, {
    systemInstruction: SYSTEM_INSTRUCTION,
    label: 'descripciones',
  });
}

// Devuelve el HTML de los bloques 1 y 2 para un modelo, generándolo solo si no
// está en caché o si el texto del proveedor ha cambiado.
//
// Se llama de forma perezosa desde processGroup, no como pre-pasada: así la
// latencia de la IA se solapa con el trabajo de Shopify y los productos
// empiezan a sincronizarse de inmediato.
//
// Devolver null NUNCA rompe nada: buildShopifyProductObject dejará
// descriptionHtml a null, se omitirá del payload, y no se tocará lo que ya
// hubiera en Shopify.
//
// Toda salida emite un evento. Si alguna se fuera en silencio, en la UI no
// habría forma de distinguir "todo servido de caché" de "se saltaron N
// productos sin avisar".
export async function ensureDescription(modelKey, modelTitle, brand = '', sourceDescription = '') {
  const emitir = (estado, motivo) =>
    sendProgress({ type: 'ai-description', modelKey, modelTitle, estado, ...(motivo ? { motivo } : {}) });

  if (!modelKey || !modelTitle) {
    emitir('omitida', 'sin modelo');
    return null;
  }

  const fuente = String(sourceDescription || '').trim();
  const sourceHash = hashSource(fuente);

  // ── 1. Caché ──────────────────────────────────────────────────────────────
  let existente = null;
  try {
    existente = await prisma.productDescription.findUnique({ where: { modelKey } });
    if (existente?.html &&
        existente.promptVersion === PROMPT_VERSION &&
        existente.sourceHash === sourceHash) {
      emitir('cache');
      return existente.html;
    }
  } catch (err) {
    logger.warn(`⚠️ [IA/descripciones] Caché no disponible: ${err?.message || err}`);
    emitir('omitida', 'caché no disponible');
    return null;
  }

  // ── 2. Sin material de origen no se puede extraer nada ────────────────────
  if (fuente.length < MIN_SOURCE_LENGTH) {
    logger.warn(`⚠️ [IA/descripciones] "${modelTitle}": el proveedor no envía descripción utilizable (${fuente.length} chars).`);
    // Si ya había una descripción guardada de una pasada anterior, se conserva
    // en lugar de dejar el producto sin nada.
    emitir(existente?.html ? 'cache' : 'omitida', existente?.html ? undefined : 'sin texto del proveedor');
    return existente?.html || null;
  }

  if (!isEnabled()) {
    emitir(existente?.html ? 'cache' : 'omitida', existente?.html ? undefined : 'sin API key');
    return existente?.html || null;
  }

  // ── 3. Generar ────────────────────────────────────────────────────────────
  emitir('generando');
  const datos = await generarDatos(modelTitle, brand, fuente);

  if (!datos) {
    emitir('fallida', 'sin respuesta de la IA');
    return existente?.html || null;
  }

  const html = sanitizeDescriptionHtml(construirHtml(datos, modelTitle));

  if (!html) {
    logger.warn(`⚠️ [IA/descripciones] "${modelTitle}": no se extrajo ninguna característica utilizable.`);
    emitir('fallida', 'sin datos extraíbles');
    return existente?.html || null;
  }

  try {
    await prisma.productDescription.upsert({
      where:  { modelKey },
      update: { html, promptVersion: PROMPT_VERSION, sourceHash },
      create: { modelKey, html, promptVersion: PROMPT_VERSION, sourceHash },
    });
  } catch (err) {
    // Se ha generado bien pero no se ha podido persistir: se devuelve igual
    // para no dejar el producto sin descripción en esta pasada.
    logger.warn(`⚠️ [IA/descripciones] No se pudo guardar "${modelKey}": ${err?.message || err}`);
  }

  const extraidas = ['pantalla', 'bateria', 'procesador', 'camaras'].filter(k => esValorUtil(datos[k]));
  logger.success(`📝 [IA/descripciones] "${modelTitle}" → ${extraidas.length}/4 specs (${extraidas.join(', ') || 'ninguna'})`);
  emitir('generada');
  return html;
}
