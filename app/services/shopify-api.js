// shopify-api.js
// Todas las llamadas directas a la API GraphQL de Shopify: crear, actualizar
// y buscar productos; gestión de variantes, metafields y publicaciones.

import { adminGraphql, logger } from './config.js';
import { sendProgress } from './progress.js';
import { normalizeString, normalizeBrand, uniqStrings, removeYouTubeTags } from '../../utils/normalize-utils.js';
import { computeProductUpdate } from './xml-sync/product-builder.js';
import {
  GET_PRODUCT_VARIANTS,
  METAFIELD_DEFINITION_CREATE,
  METAFIELD_DEFINITION_UPDATE,
  PRODUCT_CREATE,
  PRODUCT_OPTION_DELETE,
  PRODUCT_OPTION_UPDATE,
  PRODUCT_OPTIONS_CREATE,
  PRODUCT_SEARCH,
  PRODUCT_UPDATE,
  SET_PRODUCT_METAFIELDS,
} from '../shopify/queries';

// ─── Definiciones de metafields del producto ───────────────────────────────
const PRODUCT_METAFIELD_DEFINITIONS = [
  { name: "Marca",                  namespace: "custom", key: "brand",                type: "single_line_text_field" },
  { name: "Sistema operativo",      namespace: "custom", key: "os",                   type: "single_line_text_field" },
  { name: "Modelo",                 namespace: "custom", key: "model",                type: "single_line_text_field" },
  { name: "Condición",              namespace: "custom", key: "condition",            type: "single_line_text_field" },
  { name: "Condiciones disponibles",namespace: "custom", key: "conditions_available", type: "list.single_line_text_field" },
  { name: "Capacidades disponibles",namespace: "custom", key: "capacities_available", type: "list.single_line_text_field" },
  { name: "Warranty elegible",      namespace: "custom", key: "warranty_elegible",    type: "boolean" },
];

let _metafieldDefinitionsEnsured = false;

// Crea o actualiza las definiciones de metafields necesarias en Shopify.
// Se ejecuta solo una vez por sesión gracias al flag interno.
export async function ensureProductMetafieldDefinitions(admin) {
  if (_metafieldDefinitionsEnsured) return;

  for (const def of PRODUCT_METAFIELD_DEFINITIONS) {
    const createRes = await adminGraphql(admin, METAFIELD_DEFINITION_CREATE, {
      definition: {
        name: def.name,
        namespace: def.namespace,
        key: def.key,
        type: def.type,
        ownerType: "PRODUCT",
        capabilities: { adminFilterable: { enabled: true } }
      }
    });

    const createData = await createRes.json();
    const createErrors = createData?.data?.metafieldDefinitionCreate?.userErrors || [];

    if (createErrors.length === 0) continue;

    const alreadyExists = createErrors.some((e) =>
      String(e?.message || "").toLowerCase().includes("already exists")
    );

    if (alreadyExists) {
      const updateRes = await adminGraphql(admin, METAFIELD_DEFINITION_UPDATE, {
        definition: {
          namespace: def.namespace,
          key: def.key,
          ownerType: "PRODUCT",
          capabilities: { adminFilterable: { enabled: true } }
        }
      });
      const updateData = await updateRes.json();
      const updateErrors = updateData?.data?.metafieldDefinitionUpdate?.userErrors || [];
      if (updateErrors.length) {
        logger.warn("⚠️ Error actualizando definición metafield:", def.namespace, def.key, updateErrors);
      }
    } else {
      logger.warn("⚠️ Error creando definición metafield:", def.namespace, def.key, createErrors);
    }
  }

  _metafieldDefinitionsEnsured = true;
}

// Busca un producto existente en Shopify por handle derivado del modelKey.
export async function findExistingProduct(admin, group) {
  const first = group[0];
  const modelKey = first.modelKey;
  const title = first.modelTitle;

  const handle = modelKey
    ? modelKey.replace(/[^\w\s-]/g, "").replace(/\s+/g, "-").slice(0, 80)
    : null;

  try {
    const res = await adminGraphql(admin, PRODUCT_SEARCH, { query: `handle:${handle}` });
    const searchResults = await res.json();
    const edges = searchResults?.data?.products?.edges || [];
    if (edges.length > 0) return edges[0].node;
  } catch (err) {
    logger.warn(`⚠️ Error buscando producto con query="${title}": ${err?.message || err}`);
  }

  return null;
}

// Crea un nuevo producto en Shopify con sus opciones (sin variantes todavía).
export async function createShopifyProduct(admin, productObj, groupId = null) {
  const input = { ...productObj };

  if (input.descriptionHtml == null) delete input.descriptionHtml;

  if (groupId) {
    const handle = String(groupId).toLowerCase().replace(/[^\w\s-]/g, "").replace(/\s+/g, "-").slice(0, 80);
    input.handle = handle;
  }

  sendProgress({ type: "product_create_request", title: input.title, groupId });

  try {
    sendProgress({ type: "product-create-request", title: input.title, groupId });
    input.productOptions.forEach((opt) =>
      logger.detail(`Option: ${opt.name} | Values: ${opt.values.map(v => v.name).join(", ")}`)
    );

    const response = await adminGraphql(admin, PRODUCT_CREATE, {
      product: {
        title: input.title,
        vendor: input.vendor,
        productType: "Móvil",
        descriptionHtml: removeYouTubeTags(input.descriptionHtml),
        handle: input.handle,
        tags: input.tags,
        productOptions: input.productOptions,
      }
    });

    const productResult = await response.json();
    const productData = productResult?.data?.productCreate?.product;
    return { success: true, product: productData };
  } catch (err) {
    logger.error("❌ Error creating product en createShopifyProduct:", err);
    const errors = err.body?.errors || [{ message: err?.message || String(err) }];
    if (err.body?.errors) logger.error("❌ Error creating product:", errors);
    return { success: false, product: null, errors };
  }
}

// Actualiza los campos del producto (título, vendor, descripción, tags)
// solo si han cambiado respecto al estado actual en Shopify.
export async function updateShopifyProduct(admin, existingProduct, productObj, groupId = null) {
  const productId = existingProduct?.id;
  const { product, changedFields } = computeProductUpdate(existingProduct, productObj);

  sendProgress({ type: "product_update_request", title: productObj.title, productId, groupId, changedFields });

  if (changedFields.length === 0) {
    sendProgress({ type: "product_updated", productId, groupId, changedFields, noChanges: true });
    return { success: true, product: existingProduct, changedFields, noChanges: true };
  }

  try {
    const response = await adminGraphql(admin, PRODUCT_UPDATE, { product });
    const result = await response.json();
    const userErrors = result?.data?.productUpdate?.userErrors || [];

    if (userErrors.length) {
      logger.warn("⚠️ Error updating product fields:", userErrors);
      sendProgress({ type: "product_update_error", productId, groupId, errors: userErrors, changedFields });
      return { success: false, errors: userErrors };
    }

    sendProgress({ type: "product_updated", productId, groupId, changedFields, noChanges: false });
    return { success: true, product: result?.data?.productUpdate?.product || null };
  } catch (err) {
    logger.error("❌ Error updating product in updateShopifyProduct:", err);
    sendProgress({ type: "product_update_error", productId, groupId, errors: [{ message: err?.message || String(err) }], changedFields });
    return { success: false, errors: [{ message: err?.message || String(err) }] };
  }
}

// Obtiene todas las variantes de un producto con paginación automática.
// Obtiene todas las variantes de un producto con paginación automática.
// También devuelve las opciones actuales del producto (Capacidad, Color,
// Condición), obtenidas en la primera página para evitar una llamada API
// extra. Las opciones solo se leen una vez — en páginas posteriores Shopify
// las devuelve igual y se ignoran.
export async function getAllProductVariants(admin, productId) {
  const all = [];
  let productOptions = [];
  let after = null;
  const first = 100;

  while (true) {
    const res = await adminGraphql(admin, GET_PRODUCT_VARIANTS, {
      id: productId,
      first,
      after: after || undefined
    });

    const data = await res.json();
    const product = data?.data?.product;
    const connection = product?.variants;
    const nodes = connection?.nodes || [];
    const pageInfo = connection?.pageInfo || {};

    // Leer las opciones solo en la primera página
    if (productOptions.length === 0 && product?.options?.length) {
      productOptions = product.options;
    }

    all.push(...nodes);
    if (!pageInfo.hasNextPage) break;
    after = pageInfo.endCursor;
    if (!after) break;
  }

  return { variants: all, options: productOptions };
}

// Escribe los metafields personalizados del producto (marca, modelo, OS,
// condición, capacidades disponibles).
export async function setProductMetafields(admin, productId, group) {
  const base = group[0];
  const so = normalizeBrand(base.brand) === 'apple' ? 'iOS' : 'Android';
  const conditions = uniqStrings(group.map(v => v.condition));
  const capacities = uniqStrings(group.map(v => v.capacity));

  const metafields = [
    { ownerId: productId, namespace: "custom", key: "brand",                value: String(base.brand || "").trim(),  type: "single_line_text_field" },
    { ownerId: productId, namespace: "custom", key: "model",                value: base.modelTitle,                   type: "single_line_text_field" },
    { ownerId: productId, namespace: "custom", key: "os",                   value: so,                                type: "single_line_text_field" },
    { ownerId: productId, namespace: "custom", key: "condition",            value: conditions[0] || "nuevo",          type: "single_line_text_field" },
    { ownerId: productId, namespace: "custom", key: "conditions_available", value: JSON.stringify(conditions),        type: "list.single_line_text_field" },
    { ownerId: productId, namespace: "custom", key: "capacities_available", value: JSON.stringify(capacities),        type: "list.single_line_text_field" },
    // Todos los productos gestionados por la sync son elegibles para
    // ampliación de garantía.
    { ownerId: productId, namespace: "custom", key: "warranty_elegible",    value: "true",                            type: "boolean" },
  ];

  const res = await adminGraphql(admin, SET_PRODUCT_METAFIELDS, { metafields });
  const data = await res.json();
  const errors = data?.data?.metafieldsSet?.userErrors || [];
  if (errors.length) logger.warn("⚠️ Metafield errors:", errors);
}

// Sincroniza los valores de las opciones del producto en Shopify con los del feed,
// antes de crear o actualizar variantes.
//
// Problema que resuelve: Shopify rechaza VARIANTS_CREATE con "Option does not
// exist" cuando el feed cambia y trae valores de opción que aún no existen en
// el producto (ej: un modelo añade un color nuevo) o cuando hay valores en
// Shopify que ya no están en el feed.
//
// El caso de producto con opción genérica "Title" (placeholder) se resuelve
// directamente en VARIANTS_CREATE pasando strategy: REMOVE_STANDALONE_VARIANT,
// que hace que Shopify sustituya la placeholder automáticamente sin necesidad
// de gestionar las opciones manualmente desde aquí.
//
// Devuelve las opciones del producto (sin cambios si no había nada que hacer).
export async function syncProductOptions(admin, productId, existingOptions = [], desiredProductOptions = []) {
  const EXPECTED_OPTION_NAMES = ['capacidad', 'color', 'condición'];
  logger.info(`🔄 [syncProductOptions] Sincronizando opciones para producto ${productId}. Existentes: ${existingOptions.map(o => o.name).join(", ")}. Deseadas: ${desiredProductOptions.map(o => o.name).join(", ")}`);
  logger.detail(`Detalle opciones existentes: ${existingOptions.map(o => `${o.name} [${(o.optionValues || []).map(v => v.name).join(", ")}]`).join("; ")}`);

  // Si el producto no tiene opciones reales (solo Title o vacío), saltar.
  // REMOVE_STANDALONE_VARIANT en VARIANTS_CREATE lo resolverá.
  const hasRealOptions = existingOptions.some(o =>
    EXPECTED_OPTION_NAMES.includes(o.name.trim().toLowerCase())
  );

  if (!hasRealOptions) {
    logger.info(`ℹ️ [syncProductOptions] Producto ${productId} sin opciones reales todavía. Se resolverá con REMOVE_STANDALONE_VARIANT en VARIANTS_CREATE.`);
    return existingOptions;
  }

  // El producto ya tiene opciones reales: sincronizar valores desactualizados.
  for (const desiredOpt of desiredProductOptions) {
    const existingOpt = existingOptions.find(
      o => o.name.trim().toLowerCase() === desiredOpt.name.trim().toLowerCase()
    );

    if (!existingOpt) {
      logger.info(`🔧 [syncProductOptions] Opción "${desiredOpt.name}" no existe en ${productId}. Creándola.`);
      
      const createRes = await adminGraphql(admin, PRODUCT_OPTIONS_CREATE, {
        productId,
        options: [{ name: desiredOpt.name, values: desiredOpt.values }]
      });

      const createData = await createRes.json();
      const createErrors = createData?.data?.productOptionsCreate?.userErrors || [];
      
      if (createErrors.length) {
        logger.warn(`⚠️ [syncProductOptions] Error creando opción "${desiredOpt.name}":`, createErrors);
      } else {
        logger.success(`✅ [syncProductOptions] Opción "${desiredOpt.name}" creada en ${productId}.`);
      }
      
      continue;
    }

    const existingValues = (existingOpt.optionValues || []).map(v => ({
      id: v.id,
      name: v.name.trim().toLowerCase()
    }));

    const desiredValues = (desiredOpt.values || []).map(v =>
      String(v.name || '').trim().toLowerCase()
    ).filter(Boolean);

    // Valores del feed que faltan en Shopify → añadir
    const toAdd = desiredValues
      .filter(dv => !existingValues.some(ev => ev.name === dv))
      .map(name => ({ name }));

    // Valores de Shopify que ya no están en el feed → eliminar si es posible.
    // Si tienen variantes activas, Shopify lo rechazará — ese error se ignora
    // porque la limpieza ocurrirá cuando la variante sea eliminada en la purga.
    const toRemove = existingValues
      .filter(ev => !desiredValues.includes(ev.name))
      .map(ev => ev.id);

    if (toAdd.length === 0 && toRemove.length === 0) continue;

    logger.info(`🔧 [syncProductOptions] Opción "${desiredOpt.name}" en ${productId}: +[${toAdd.map(v => v.name).join(', ')}] -[${toRemove.join(', ')}]`);

    const res = await adminGraphql(admin, PRODUCT_OPTION_UPDATE, {
      productId,
      option: { id: existingOpt.id, name: existingOpt.name },
      optionValuesToAdd: toAdd.length > 0 ? toAdd : undefined,
      optionValuesToDelete: toRemove.length > 0 ? toRemove : undefined,
    });

    const data = await res.json();
    const errors = data?.data?.productOptionUpdate?.userErrors || [];
    if (errors.length) {
      logger.warn(`⚠️ [syncProductOptions] Errores actualizando opción "${desiredOpt.name}":`, errors);
      
    }
  }

  return existingOptions;
}