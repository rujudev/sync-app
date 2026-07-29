// model-identity.js
// Congelación de identidad de producto.
//
// modelKey deriva en el handle de Shopify, así que si cambia, findExistingProduct
// no encuentra el producto, se crea un duplicado y reconcileOrphanProducts borra
// el original. Para que eso no ocurra jamás, todo título cuyo modelo YA tenga
// producto publicado queda congelado con su resolución actual.
//
// Se ejecuta en CADA sync a propósito:
//   - Los productos creados hoy quedan protegidos mañana.
//   - Cubre también los títulos resueltos por el extractor determinista cuando
//     la IA está apagada, que si no quedarían sin fila en caché y podrían
//     derivar el día que se active.
// Es idempotente: nunca sobrescribe una fila existente.

import prisma from '../../db.server.js';
import { adminGraphql, logger } from '../config.js';
import { buildCacheKey, resolveModelDeterministic } from '../xml-sync/feed-normalizer.js';
import { GET_PRODUCTS_BY_TAG } from '../../shopify/queries.js';

const MANAGED_PRODUCT_TAG = 'cosladafon';
const DB_CHUNK = 400;

// Debe coincidir EXACTAMENTE con findExistingProduct (shopify-api.js:89-91).
const handleFromModelKey = (modelKey) =>
  modelKey ? modelKey.replace(/[^\w\s-]/g, "").replace(/\s+/g, "-").slice(0, 80) : null;

// Sufijos que son calificador real de modelo, no basura del título.
const SUFIJOS_LEGITIMOS = new Set([
  'pro', 'max', 'ultra', 'lite', 'mini', 'plus', 'fe', 'air', 'edge',
  'fold', 'flip', 'se', 'xl', 'neo', 'turbo', 'prime', 'power', 'active',
]);

// normalizeText conserva el "+", así que "pro+" (Redmi Note 13 Pro+, un modelo
// real y distinto del Pro) no casaría con la lista. Se compara sin él.
const esSufijoLegitimo = (token) =>
  SUFIJOS_LEGITIMOS.has(String(token).replace(/\+$/, ''));

export async function freezeLiveResolutions(admin, rawItems) {
  const resumen = {
    productosVivos: 0, congeladosAhora: 0, yaEnCache: 0, fragmentaciones: [],
  };

  // ── 1. Handles publicados ────────────────────────────────────────────────
  const liveHandles = new Set();
  let cursor = null;
  do {
    const res = await adminGraphql(admin, GET_PRODUCTS_BY_TAG, {
      query: `tag:${MANAGED_PRODUCT_TAG}`, cursor,
    });
    const conn = (await res.json())?.data?.products;
    for (const e of conn?.edges || []) {
      if (e?.node?.handle) liveHandles.add(e.node.handle);
    }
    cursor = conn?.pageInfo?.hasNextPage ? conn.pageInfo.endCursor : null;
  } while (cursor);
  resumen.productosVivos = liveHandles.size;

  // ── 2. Resolución determinista de todos los títulos distintos ────────────
  const distinct = new Map();
  for (const item of rawItems) {
    const get = f => item[`g:${f}`] ?? item[f] ?? '';
    if (String(get('id') || '').includes('TEST')) continue;
    const key = buildCacheKey(item);
    if (distinct.has(key)) continue;
    const det = resolveModelDeterministic(item);
    if (!det.modelKey) continue;
    distinct.set(key, {
      cacheKey: key,
      rawTitle: String(get('title') || '').trim(),
      brand: String(get('brand') || '').trim(),
      ...det,
      source: 'seed', agreed: true,
      frozen: liveHandles.has(handleFromModelKey(det.modelKey)),
    });
  }

  // ── 3. Escribir solo las que falten y estén vivas ────────────────────────
  const existentes = new Set();
  const keys = [...distinct.keys()];
  for (let i = 0; i < keys.length; i += DB_CHUNK) {
    const rows = await prisma.modelResolution.findMany({
      where: { cacheKey: { in: keys.slice(i, i + DB_CHUNK) } },
      select: { cacheKey: true },
    });
    rows.forEach(r => existentes.add(r.cacheKey));
  }
  resumen.yaEnCache = existentes.size;

  for (const row of distinct.values()) {
    if (!row.frozen || existentes.has(row.cacheKey)) continue;
    try {
      await prisma.modelResolution.create({ data: row });
      resumen.congeladosAhora++;
    } catch { /* carrera: ya existe, nada que hacer */ }
  }

  // ── 4. Diagnóstico: fragmentaciones sospechosas ──────────────────────────
  // Una clave que es prefijo de otra puede ser un modelo distinto de verdad
  // ("iphone 11" vs "iphone 11 pro") o una fragmentación por un color o resto
  // que el extractor no supo limpiar ("iphone 17" vs "iphone 17 mist").
  //
  // Cada fragmento se evalúa UNA sola vez, contra su base más cercana (el
  // prefijo propio más largo). Comparando contra todos los ancestros salía el
  // mismo caso repetido en cascada: "iphone 17 pro max comic" aparecía tres
  // veces, contra "iphone 17", "iphone 17 pro" y "iphone 17 pro max".
  const modelKeys = [...new Set([...distinct.values()].map(r => r.modelKey))].sort();
  const vivas = new Set(modelKeys.filter(k => liveHandles.has(handleFromModelKey(k))));

  for (const hijo of modelKeys) {
    const base = modelKeys
      .filter(o => o !== hijo && hijo.startsWith(o + ' '))
      .sort((a, b) => b.length - a.length)[0];
    if (!base) continue;

    const extra = hijo.slice(base.length).trim().split(/\s+/);
    if (extra.every(esSufijoLegitimo)) continue; // modelo distinto real

    resumen.fragmentaciones.push({
      base, fragmento: hijo, sobra: extra.join(' '),
      fragmentoVivo: vivas.has(hijo),
    });
  }

  logger.info(`🔒 [IDENTIDAD] Vivos: ${resumen.productosVivos} | Congelados ahora: ${resumen.congeladosAhora} | Ya en caché: ${resumen.yaEnCache} | Fragmentaciones: ${resumen.fragmentaciones.length}`);
  return resumen;
}
