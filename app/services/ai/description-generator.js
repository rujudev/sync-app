// description-generator.js
// Genera el copy de producto por modelo. Una llamada por modelo, cacheada
// para siempre: la descripción depende SOLO del modelo, no del stock ni de
// las capacidades o condiciones disponibles.
//
// Sin cifras de specs: el catálogo incluye modelos posteriores al corte de
// conocimiento del modelo de lenguaje (iPhone 17e, Xiaomi 17 Ultra, Galaxy
// A57…) y cualquier dato técnico concreto sería inventado.

import prisma from '../../db.server.js';
import { logger } from '../config.js';
import { sendProgress } from '../progress.js';
import { callJson, isEnabled } from './gemini-client.js';
import { sanitizeDescriptionHtml } from './sanitize-html.js';

// Súbela para regenerar todo el catálogo a propósito tras cambiar el estilo.
export const PROMPT_VERSION = 1;

const SYSTEM_INSTRUCTION = `
Escribes fichas de producto para SecondTech, una tienda española de móviles
reacondicionados y de segunda mano.

CONTEXTO: recibirás el nombre del modelo y su categoría (móvil, tablet, etc.)
en el mensaje de usuario. Úsalos tal cual, sin inventar variantes ni datos
adicionales sobre ellos.

TONO
- Cercano y directo, español de España, tuteo.
- Nada de lenguaje de folleto ni superlativos vacíos ("increíble", "te
  enamorará", "no te dejará indiferente").
- Frases cortas. Evita el relleno: si no tienes algo concreto que decir,
  no lo digas con más palabras.

PROHIBIDO INCLUIR (nunca los conoces con certeza; un dato falso es un
problema legal):
- Pulgadas de pantalla, megapíxeles, mAh de batería, nombre del procesador,
  RAM, almacenamiento, año de lanzamiento, o cualquier otra cifra técnica.
- Capacidades disponibles, colores, condición/estado del producto, precio,
  garantía, plazos de envío, estado de la batería.
Todo eso se gestiona por separado en la ficha; si lo mencionas, se duplica
o se contradice con esa información.

QUÉ SÍ CONTAR
- Para quién es este modelo (tipo de usuario, uso diario, fotografía,
  gaming, autonomía en el uso, etc.) sin cifras.
- Qué gana el cliente comprando reacondicionado en SecondTech frente a
  comprar nuevo (ahorro, sostenibilidad, revisión y control de calidad).
- Sensaciones de uso reales pero genéricas (fluidez, tamaño manejable,
  cámara fiable) sin prometer specs.

FORMATO
- HTML simple: solo <h4>, <p>, <ul>, <li>, <strong>. Sin atributos, sin
  enlaces, sin imágenes, sin anidar etiquetas de bloque entre sí.
- 3 a 5 bloques (mezcla de párrafos y alguna lista si aporta claridad).
- Extensión orientativa: entre 900 y 1400 caracteres. Prioriza que suene
  natural y completo antes que ajustarte al carácter exacto.
- Empieza directamente con el contenido, sin título con el nombre del modelo.

EJEMPLO (para un smartphone de gama media, mismo tono y estructura que
debes seguir):

<p>Si buscas un móvil para el día a día sin complicarte con especificaciones
que no vas a mirar nunca, este es de esos que cumplen sin hacer ruido.
Aguanta bien el ritmo de cualquier jornada: redes sociales, cámara, WhatsApp
y navegación sin tirones raros.</p>
<p>La cámara responde de forma fiable en el uso habitual: fotos de familia,
viajes o el típico "mándame la ubicación" en el grupo. No es un equipo
pensado para fotografía profesional, sino para quien quiere sacar buenas
fotos sin pensar en ajustes.</p>
<h4>¿Por qué comprarlo reacondicionado en SecondTech?</h4>
<ul>
<li>Pasa por un proceso de revisión antes de llegar a tus manos.</li>
<li>Pagas menos que por un equipo nuevo equivalente.</li>
<li>Alargas la vida útil de un dispositivo en lugar de generar otro nuevo.</li>
</ul>
<p>Un equipo pensado para quien quiere un móvil que simplemente funcione,
sin sobrepagar por prestaciones que no va a usar.</p>

ANTES DE RESPONDER, comprueba:
- ¿Hay alguna cifra o dato técnico concreto? Elimínalo.
- ¿Hay algún color, condición, precio, garantía o plazo mencionado? Elimínalo.
- ¿Suena a folleto genérico o aporta algo sobre el uso real? Reescribe si
  suena vacío.
- ¿Usa solo las etiquetas permitidas, sin atributos?
`.trim();

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: { html: { type: 'STRING' } },
  required: ['html'],
};

async function generateOne(modelTitle, brand) {
  const prompt =
    `Escribe la descripción para: ${modelTitle}` +
    (brand ? ` (marca: ${brand})` : '') + '.';

  const out = await callJson(prompt, RESPONSE_SCHEMA, {
    systemInstruction: SYSTEM_INSTRUCTION,
    label: 'descripciones',
  });

  return sanitizeDescriptionHtml(out?.html);
}

// Devuelve el HTML de la descripción de un modelo, generándolo solo si no
// está ya en caché.
//
// Se llama de forma perezosa desde processGroup, no como pre-pasada: así la
// latencia de la IA se solapa con el trabajo de Shopify y los productos
// empiezan a sincronizarse de inmediato. Como pre-pasada bloqueaba la sync
// varios minutos sin tocar nada, y parecía colgada.
//
// Devolver null NUNCA rompe nada: buildShopifyProductObject dejará
// descriptionHtml a null, se omitirá del payload, y no se tocará lo que ya
// hubiera en Shopify.
export async function ensureDescription(modelKey, modelTitle, brand = '') {
  if (!modelKey || !modelTitle) return null;

  // ── 1. Caché ──────────────────────────────────────────────────────────────
  try {
    const row = await prisma.productDescription.findUnique({ where: { modelKey } });
    if (row?.html && row.promptVersion === PROMPT_VERSION) {
      sendProgress({ type: "ai-description", modelKey, modelTitle, estado: "cache" });
      return row.html;
    }
  } catch (err) {
    logger.warn(`⚠️ [IA/descripciones] Caché no disponible: ${err?.message || err}`);
    return null;
  }

  if (!isEnabled()) return null;

  // ── 2. Generar ────────────────────────────────────────────────────────────
  sendProgress({ type: "ai-description", modelKey, modelTitle, estado: "generando" });
  const html = await generateOne(modelTitle, brand);

  if (!html) {
    logger.warn(`⚠️ [IA/descripciones] Sin resultado válido para "${modelTitle}"`);
    sendProgress({ type: "ai-description", modelKey, modelTitle, estado: "fallida" });
    return null;
  }

  try {
    await prisma.productDescription.upsert({
      where:  { modelKey },
      update: { html, promptVersion: PROMPT_VERSION },
      create: { modelKey, html, promptVersion: PROMPT_VERSION },
    });
  } catch (err) {
    // Se ha generado bien pero no se ha podido persistir: se devuelve igual
    // para no dejar el producto sin descripción en esta pasada.
    logger.warn(`⚠️ [IA/descripciones] No se pudo guardar "${modelKey}": ${err?.message || err}`);
  }

  logger.success(`📝 [IA/descripciones] Generada para "${modelTitle}"`);
  sendProgress({ type: "ai-description", modelKey, modelTitle, estado: "generada" });
  return html;
}
