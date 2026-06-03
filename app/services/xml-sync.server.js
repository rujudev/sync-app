// xml-sync.server.js
// Punto de entrada del módulo de sincronización XML → Shopify.
// Re-exporta únicamente la superficie pública necesaria para las rutas
// y para los tests de integración. Toda la lógica real vive en los
// módulos específicos.

export { syncXmlString } from './xml-sync/sync-engine.js';
export { attachSendProgress, sendProgress } from './progress.js';
export { adminGraphql, CONFIG, log } from './config.js';

// Helpers expuestos para tests externos
export { buildShopifyProductObject } from './xml-sync/product-builder.js';
export { normalizeFeedItem, groupByModelKey } from './xml-sync/feed-normalizer.js';
export { parseXmlItems } from './xml-sync/xml-parser.js';
