// model-resolver.js
// Resolución del modelo comercial a partir del título crudo del proveedor.
//
// Es la ÚNICA parte del pipeline donde la IA toca algo que afecta a la
// identidad del producto (modelKey → handle de Shopify). Lo que lo hace
// seguro es que el resultado se congela en caché por título exacto: el modelo
// es no determinista, pero el sistema sí lo es.
//
// Reglas de negocio (precios, márgenes, filtros, tags) NO entran aquí.

import prisma from '../../db.server.js';
import { logger } from '../config.js';
import { sendProgress } from '../progress.js';
import { normalizeText, normalizeBrand } from '../../../utils/normalize-utils.js';
import { buildCacheKey, resolveModelDeterministic } from '../xml-sync/feed-normalizer.js';
import { callJson, isEnabled } from './gemini-client.js';

const BATCH_SIZE = 25;
const DB_CHUNK = 400; // SQLite limita el nº de variables por consulta

const SYSTEM_INSTRUCTION = `
Eres un normalizador de catálogos de telefonía. Recibes títulos de producto
escritos por un proveedor mayorista, con erratas, y devuelves el modelo
comercial exacto.

REGLAS:
1. Devuelve el nombre COMERCIAL del modelo, tal y como lo llama el fabricante.
2. Elimina del nombre: capacidad, color, "5G"/"4G", "Dual SIM", "DS", "Duos",
   y códigos internos (SM-S918B, G996B/DS, F926B…).
3. Respeta el capitalizado oficial del fabricante: "iPhone" (no "Iphone"),
   "13T" (no "13t"), "FE" (no "Fe"), "Galaxy Z Fold7".
4. Corrige erratas evidentes del proveedor ("Galazy" → "Galaxy").
5. Para Apple NO incluyas la marca: "iPhone 15 Pro", nunca "Apple iPhone 15 Pro".
   Para el resto de marcas SÍ: "Samsung Galaxy S24", "Xiaomi 14 Ultra".
6. Son MODELOS DISTINTOS y no se deben unificar: base vs FE, vs "e"
   (iPhone 17e), vs Air, vs Plus/+, vs Pro, vs Pro Max, vs Ultra, vs Lite.
7. modelKey = modelTitle en minúsculas, sin acentos ni signos.
8. capacity: formato "256GB" o "1TB". Cadena vacía si no aparece en el título.
9. color: el color en español, en minúsculas y en UNA palabra siempre que se
   pueda ("azul", "negro", "grafito"). Cadena vacía si no aparece.
10. Si un título es ambiguo o no reconoces el modelo, devuelve modelTitle
    vacío. Es preferible a inventarlo.

No añadas explicaciones. Devuelve solo el JSON del esquema.
`.trim();

const RESPONSE_SCHEMA = {
  type: 'ARRAY',
  items: {
    type: 'OBJECT',
    properties: {
      id:         { type: 'INTEGER' },
      modelTitle: { type: 'STRING' },
      modelKey:   { type: 'STRING' },
      capacity:   { type: 'STRING' },
      color:      { type: 'STRING' },
    },
    required: ['id', 'modelTitle', 'modelKey', 'capacity', 'color'],
  },
};

// Descarta cualquier resolución que no cumpla el formato esperado.
// Lo rechazado cae al extractor determinista, que es el comportamiento actual.
function isValid(r, brand) {
  if (!r || typeof r !== 'object') return false;

  const modelTitle = String(r.modelTitle || '').trim();
  const modelKey   = String(r.modelKey || '').trim();

  if (!modelTitle || !modelKey) return false;
  if (modelTitle.length > 60) return false;
  if (!/[a-z]/i.test(modelTitle)) return false;

  // La clave debe ser derivable del título: si no, el handle sería impredecible
  if (modelKey !== normalizeText(modelTitle)) return false;

  const capacity = String(r.capacity || '').trim();
  if (capacity && !/^\d{1,4}(GB|TB)$/i.test(capacity)) return false;

  // Convención de marca idéntica a la del extractor actual (paso 14)
  const b = normalizeBrand(brand);
  const lower = modelTitle.toLowerCase();
  if (b === 'apple') {
    if (lower.startsWith('apple')) return false;
  } else if (b && !lower.startsWith(b + ' ')) {
    return false;
  }

  return true;
}

async function resolveBatch(batch) {
  const lines = batch
    .map(({ item }, i) => {
      const get = f => item[`g:${f}`] ?? item[f] ?? '';
      return `${i}. [marca: ${String(get('brand') || '?').trim()}] ${String(get('title') || '').trim()}`;
    })
    .join('\n');

  const prompt =
    `Normaliza estos ${batch.length} títulos. Devuelve un elemento por cada uno, ` +
    `con "id" igual al número de la línea.\n\n${lines}`;

  const out = await callJson(prompt, RESPONSE_SCHEMA, {
    systemInstruction: SYSTEM_INSTRUCTION,
    label: 'modelos',
  });

  return Array.isArray(out) ? out : null;
}

export async function resolveModels(rawItems) {
  const out = new Map();

  // ── 1. Items distintos por cacheKey ───────────────────────────────────────
  const distinct = new Map();
  for (const item of rawItems) {
    const get = f => item[`g:${f}`] ?? item[f] ?? '';
    if (String(get('id') || '').includes('TEST')) continue;
    const key = buildCacheKey(item);
    if (!distinct.has(key)) distinct.set(key, item);
  }

  // ── 2. Caché ──────────────────────────────────────────────────────────────
  // Lo almacenado se usa SIEMPRE, esté congelado o no. `frozen` solo protege
  // frente a que el sembrado (paso 0) lo sobrescriba. Para forzar que un
  // título se vuelva a resolver, borra su fila — pero nunca la de un modelo
  // que ya tenga producto publicado en Shopify.
  const keys = [...distinct.keys()];
  try {
    for (let i = 0; i < keys.length; i += DB_CHUNK) {
      const rows = await prisma.modelResolution.findMany({
        where: { cacheKey: { in: keys.slice(i, i + DB_CHUNK) } },
      });
      for (const row of rows) {
        out.set(row.cacheKey, {
          modelTitle: row.modelTitle,
          modelKey:   row.modelKey,
          capacity:   row.capacity || null,
          color:      row.color || null,
        });
      }
    }
  } catch (err) {
    // Sin acceso al caché no podemos garantizar estabilidad de modelKey.
    // Devolver vacío hace que todo caiga al extractor determinista.
    logger.error(`❌ [IA/modelos] Caché no disponible, se usa el extractor: ${err?.message || err}`);
    sendProgress({
      type: "ai-resolve-end",
      desdeCache: 0, resueltos: 0, descartados: 0, discrepan: 0,
      error: "caché no disponible",
    });
    return new Map();
  }

  const desdeCache = out.size;
  const pending = [...distinct.entries()].filter(([k]) => !out.has(k));
  logger.info(`🔤 [IA/modelos] ${desdeCache} en caché | ${pending.length} por resolver`);

  if (!pending.length) {
    sendProgress({ type: "ai-resolve-end", desdeCache, resueltos: 0, descartados: 0, discrepan: 0 });
    return out;
  }
  if (!isEnabled()) {
    logger.warn(`⚠️ [IA/modelos] Sin API key: ${pending.length} títulos irán por el extractor.`);
    sendProgress({
      type: "ai-resolve-end",
      desdeCache, resueltos: 0, descartados: 0, discrepan: 0,
      sinClave: pending.length,
    });
    return out;
  }

  // ── 3. Resolver los pendientes por lotes ──────────────────────────────────
  let resolved = 0, rejected = 0, disagreed = 0;

  const totalLotes = Math.ceil(pending.length / BATCH_SIZE);

  for (let i = 0; i < pending.length; i += BATCH_SIZE) {
    const lote = Math.floor(i / BATCH_SIZE) + 1;
    const batch = pending.slice(i, i + BATCH_SIZE).map(([cacheKey, item]) => ({ cacheKey, item }));

    logger.info(`🔤 [IA/modelos] Lote ${lote}/${totalLotes} (${batch.length} títulos)…`);
    sendProgress({ type: "ai-resolve-progress", lote, totalLotes, titulos: batch.length });

    const results = await resolveBatch(batch);

    if (!results) {
      logger.warn(`⚠️ [IA/modelos] Lote ${lote} fallido — esos títulos usarán el extractor.`);
      continue;
    }

    for (const r of results) {
      const entry = batch[Number(r?.id)];
      if (!entry) continue;

      const get = f => entry.item[`g:${f}`] ?? entry.item[f] ?? '';
      const brand = String(get('brand') || '').trim();

      if (!isValid(r, brand)) {
        rejected++;
        continue;
      }

      // Contraste con el extractor actual: no decide nada, pero deja marcado
      // qué títulos conviene revisar a mano.
      const det = resolveModelDeterministic(entry.item);
      const agreed = det.modelKey === r.modelKey;
      if (!agreed) disagreed++;

      const row = {
        cacheKey:   entry.cacheKey,
        rawTitle:   String(get('title') || '').trim(),
        brand,
        modelTitle: String(r.modelTitle).trim(),
        modelKey:   String(r.modelKey).trim(),
        capacity:   String(r.capacity || '').trim().toUpperCase() || null,
        color:      String(r.color || '').trim().toLowerCase() || null,
        source:     'ai',
        agreed,
        frozen:     false,
      };

      try {
        await prisma.modelResolution.upsert({
          where:  { cacheKey: row.cacheKey },
          update: {},           // nunca pisar una resolución existente
          create: row,
        });
        out.set(row.cacheKey, {
          modelTitle: row.modelTitle,
          modelKey:   row.modelKey,
          capacity:   row.capacity,
          color:      row.color,
        });
        resolved++;
      } catch (err) {
        logger.warn(`⚠️ [IA/modelos] No se pudo guardar "${row.rawTitle}": ${err?.message || err}`);
      }
    }
  }

  logger.info(`🔤 [IA/modelos] Resueltos: ${resolved} | Descartados: ${rejected} | Discrepan del extractor: ${disagreed}`);
  sendProgress({
    type: "ai-resolve-end",
    desdeCache,
    resueltos: resolved,
    descartados: rejected,
    discrepan: disagreed,
  });
  return out;
}
