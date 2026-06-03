// shopify-api.js
// Todas las llamadas directas a la API GraphQL de Shopify: crear, actualizar
// y buscar productos; gestión de variantes, metafields y publicaciones.

import { adminGraphql, log } from './config.js';
import { sendProgress } from './progress.js';
import { normalizeString, normalizeBrand, uniqStrings, removeYouTubeTags } from '../../utils/normalize-utils.js';
import { computeProductUpdate } from './xml-sync/product-builder.js';
import {
  GET_PRODUCT_VARIANTS,
  METAFIELD_DEFINITION_CREATE,
  METAFIELD_DEFINITION_UPDATE,
  PRODUCT_CREATE,
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
        log("⚠️ Error actualizando definición metafield:", def.namespace, def.key, updateErrors);
      }
    } else {
      log("⚠️ Error creando definición metafield:", def.namespace, def.key, createErrors);
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
    log(`⚠️ Error buscando producto con query="${title}": ${err?.message || err}`);
  }

  return null;
}

// Crea un nuevo producto en Shopify con sus opciones (sin variantes todavía).
export async function createShopifyProduct(admin, productObj, groupId = null) {
  const input = { ...productObj };

  if (groupId) {
    const handle = String(groupId).toLowerCase().replace(/[^\w\s-]/g, "").replace(/\s+/g, "-").slice(0, 80);
    input.handle = handle;
  }

  sendProgress({ type: "product_create_request", title: input.title, groupId });

  try {
    sendProgress({ type: "product-create-request", title: input.title, groupId });
    input.productOptions.forEach((opt) =>
      log(" - Option:", opt.name, "Values:", opt.values.map(v => v.name).join(", "))
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
    log("⚠️ Error creating product en createShopifyProduct:", err);
    const errors = err.body?.errors || [{ message: err?.message || String(err) }];
    if (err.body?.errors) log("⚠️ Error creating product:", errors);
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
      log("⚠️ Error updating product fields:", userErrors);
      sendProgress({ type: "product_update_error", productId, groupId, errors: userErrors, changedFields });
      return { success: false, errors: userErrors };
    }

    sendProgress({ type: "product_updated", productId, groupId, changedFields, noChanges: false });
    return { success: true, product: result?.data?.productUpdate?.product || null };
  } catch (err) {
    log("⚠️ Error updating product in updateShopifyProduct:", err);
    sendProgress({ type: "product_update_error", productId, groupId, errors: [{ message: err?.message || String(err) }], changedFields });
    return { success: false, errors: [{ message: err?.message || String(err) }] };
  }
}

// Obtiene todas las variantes de un producto con paginación automática.
export async function getAllProductVariants(admin, productId) {
  const all = [];
  let after = null;
  const first = 100;

  while (true) {
    const res = await adminGraphql(admin, GET_PRODUCT_VARIANTS, {
      id: productId,
      first,
      after: after || undefined
    });

    const data = await res.json();
    const connection = data?.data?.product?.variants;
    const nodes = connection?.nodes || [];
    const pageInfo = connection?.pageInfo || {};

    all.push(...nodes);
    if (!pageInfo.hasNextPage) break;
    after = pageInfo.endCursor;
    if (!after) break;
  }

  return all;
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
  ];

  const res = await adminGraphql(admin, SET_PRODUCT_METAFIELDS, { metafields });
  const data = await res.json();
  const errors = data?.data?.metafieldsSet?.userErrors || [];
  if (errors.length) log("⚠️ Metafield errors:", errors);
}
