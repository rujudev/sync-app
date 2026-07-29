// product-builder.js
// Transforma grupos de items del feed en objetos de producto/variante listos
// para enviar a la API de Shopify. No realiza llamadas async ni I/O.

import { normalizeString, normalizeBrand, uniqStrings, isUsableIdentifier, normalizeTextField, normalizeTags, removeYouTubeTags } from '../../../utils/normalize-utils.js';
import { pickGroupDescription } from './feed-normalizer.js';

// ─── Aviso legal que se añade a productos reacondicionados/usados ───
const REFURBISHED_LEGAL_NOTICE_HTML = (model) => `
<h6>¿Por qué elegir SECONDTECH?</h6>
<p class="tw:leading-normal">En <strong>SecondTech</strong> no solo te ofrecemos tecnología de la más alta calidad, como el <strong>${model}</strong>, sino también una experiencia de compra premium. Nuestro equipo de expertos está siempre listo para asesorarte y ayudarte a encontrar el dispositivo que mejor se adapte a tu ritmo de vida y necesidades. Además, respaldamos cada compra con 1 año de garantía propia para asegurar tu total tranquilidad.</p>
<h6>Ventajas de comprar tu <strong>${model}</strong> con <strong>SecondTech</strong>:</h6>
<ul>
  <li><strong>Precios competitivos:</strong> Ofrecemos las tarifas más competitivas del mercado nacional.</li>
  <li><strong>Atención 100% personalizada:</strong> Nos olvidamos de los bots; nuestro equipo resuelve tus dudas de forma directa y humana. Bien por WhatsApp, teléfono o mediante chat directo en nuestra web en horario comercial.</li>
  <li><strong>Confianza y Seguridad:</strong> Todos nuestros productos reacondicionados incluyen 1 año de garantía y nuestra plataforma de pago es 100% segura.</li>
  <li><strong>Ampliación de garantía exclusiva:</strong> Somos los únicos en el sector del reacondicionado que te permiten extender tu garantía*. De hecho, el 97% de nuestros clientes eligen ampliar su garantía. Por algo será.</li>
</ul>
<p class="tw:leading-normal">¡Tú solo disfruta de tu nuevo dispositivo; de lo demás, nos encargamos nosotros!</p>
<p class="tw:leading-normal">Compra tu <strong>${model}</strong> en <strong>SecondTech</strong> y descubre por qué somos la tienda de tecnología reacondicionada preferida en España.</p>
<h6>Estado de la batería</h6>
<p class="tw:leading-normal">Las baterías de todos nuestros dispositivos reacondicionados son comprobadas por nuestros técnicos expertos. En todos los dispositivos nos aseguramos de que disponen de una salud de batería igual o superior al <strong>85% mínimo</strong>. Por debajo del 85%, siempre las cambiamos.</p>
<h6>Información legal y garantía</h6>
<p class="tw:leading-normal"><strong>IVA INCLUIDO EN EL PRECIO INDICADO POR APLICACIÓN DEL RÉGIMEN ESPECIAL DE BIENES USADOS (Art. 137 y 138 de la Ley 37/1992 de 28 de Diciembre)</strong></p>
<p class="tw:leading-normal">Productos y Servicios bajo la ley de garantías. Decreto-ley 7/2021</p>
<p class="tw:leading-normal"><strong>1 año de garantía.</strong></p>
<p class="tw:leading-normal">Canon digital: <strong>3,25 €</strong> (incluido en el precio)</p>
`;

export function buildDescriptionHtml(model, baseDescription = "", conditions = []) {
  const hasRefurbished = conditions.some(c => ["refurbished","used"].includes(String(c).toLowerCase()));
  const cleanBase = baseDescription || "";
  if (!cleanBase && !hasRefurbished) return null;   // ← nada que escribir
  if (!hasRefurbished) return cleanBase;
  return cleanBase
    ? `${cleanBase}${REFURBISHED_LEGAL_NOTICE_HTML(model)}`
    : null;                                          // ← NO publicar el legal solo
}

// Ordena capacidades numéricamente (GB < TB).
export function sortCapacities(a, b) {
  const parse = (str) => {
    const num = parseFloat(str);
    if (isNaN(num)) return 0;
    return /TB|TERA/i.test(str) ? num * 1024 : num;
  };
  return parse(a) - parse(b);
}

// Normaliza un array de optionValues para comparación canónica.
export function normalizeOptions(arr = []) {
  return arr
    .map(opt => ({
      name: (opt.optionName || opt.name || "").trim().toLowerCase(),
      value: (opt.value || opt.name || "").trim().toLowerCase()
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Construye la clave de opciones desde selectedOptions de Shopify.
export function buildOptionsKeyFromSelectedOptions(selectedOptions = []) {
  return selectedOptions
    .map((opt) => ({ name: normalizeString(opt?.name), value: normalizeString(opt?.value) }))
    .filter((x) => x.name && x.value)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((x) => `${x.name}:${x.value}`)
    .join("|");
}

// Construye la clave de opciones desde optionValues del feed.
export function buildOptionsKeyFromOptionValues(optionValues = []) {
  return optionValues
    .map((opt) => ({ name: normalizeString(opt?.optionName), value: normalizeString(opt?.name) }))
    .filter((x) => x.name && x.value)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((x) => `${x.name}:${x.value}`)
    .join("|");
}

// Detecta si una variante del feed ya existe en una lista (por opciones).
export function isDuplicateVariant(existing, variant) {
  const incomingKey = buildOptionsKeyFromOptionValues(variant?.optionValues || []);
  if (!incomingKey) return false;
  return existing.some((ev) => {
    const existingKey = ev?.selectedOptions
      ? buildOptionsKeyFromSelectedOptions(ev.selectedOptions)
      : buildOptionsKeyFromOptionValues(ev?.optionValues || []);
    return existingKey === incomingKey;
  });
}

// Busca una variante existente de Shopify por SKU, barcode u opciones.
export function findVariant(existingVariants, newVariant) {
  const newSku = normalizeString(newVariant?.sku);
  const newBarcode = normalizeString(newVariant?.barcode);
  const newOptionsKey = buildOptionsKeyFromOptionValues(newVariant?.optionValues || []);

  if (isUsableIdentifier(newSku)) {
    const bySku = existingVariants.find((ev) => normalizeString(ev?.sku) === newSku);
    if (bySku) return bySku;
  }

  if (isUsableIdentifier(newBarcode)) {
    const byBarcode = existingVariants.find((ev) => normalizeString(ev?.barcode) === newBarcode);
    if (byBarcode) return byBarcode;
  }

  if (newOptionsKey) {
    const byOptions = existingVariants.find(ev =>
      buildOptionsKeyFromSelectedOptions(ev?.selectedOptions || []) === newOptionsKey
    );
    if (byOptions) return byOptions;
  }

  return null;
}

// ── CORRECCIÓN BUG #5 ── Corregir comparación de opciones en variantNeedsUpdate.
//
// Problema original: la función comparaba `key(existingVar)` vs `key(newVar)`
// usando `JSON.stringify(v.normalizedOptions)`. El problema era una asimetría
// en cómo se construían las normalizedOptions de cada origen:
//
//   - Variante de Shopify (existingVar): normalizedOptions se construía desde
//     `selectedOptions` (formato { name: "Capacidad", value: "128GB" }),
//     por lo que normalizeOptions usaba `opt.value` para el campo `value`.
//
//   - Variante del feed (newVar): normalizedOptions se construía desde
//     `optionValues` (formato { optionName: "Capacidad", name: "128GB" }),
//     donde `opt.value` no existe, así que normalizeOptions usaba `opt.name`
//     como fallback para el campo `value`.
//
// El resultado era que, aunque las opciones fueran idénticas en contenido,
// la clave JSON podía diferir según el origen, produciendo falsos positivos
// (actualizaciones innecesarias) o falsos negativos (cambios no detectados).
//
// Solución: normalizar ambas variantes a través de sus respectivas funciones
// canónicas (buildOptionsKeyFromSelectedOptions para Shopify y
// buildOptionsKeyFromOptionValues para el feed) antes de comparar,
// garantizando que ambas claves se construyen con la misma lógica de campo.
export function variantNeedsUpdate(existingVar, newVar) {
  const norm = s => String(s || "").trim().toLowerCase();
  if (norm(existingVar.sku) !== norm(newVar.sku)) return true;
  if (Number(existingVar.price) !== Number(newVar.price)) return true;
  if (norm(existingVar.barcode) !== norm(newVar.barcode)) return true;
  if ((existingVar.currentMediaId || null) !== (newVar.mediaId || null)) return true;

  // Comparar opciones usando las funciones canónicas de cada origen para evitar
  // la asimetría entre selectedOptions (Shopify) y optionValues (feed).
  const existingOptionsKey = buildOptionsKeyFromSelectedOptions(existingVar.selectedOptions || []);
  const newOptionsKey = buildOptionsKeyFromOptionValues(newVar.optionValues || []);
  if (existingOptionsKey !== newOptionsKey) return true;

  return false;
}

// Calcula qué campos del producto han cambiado respecto al estado en Shopify.
// ── CORRECCIÓN BUG #7 ── Detectar cambios en productOptions sin enviarlos
// en el payload de productUpdate.
//
// Problema original: computeProductUpdate no comparaba las opciones del
// producto (productOptions). Si el feed añadía o eliminaba una capacidad,
// color o condición, Shopify nunca recibía la actualización, dejando valores
// huérfanos visibles en el admin.
//
// La solución correcta NO es incluir productOptions en productUpdate, porque
// Shopify rechaza ese campo en esa mutation ("Field is not defined on
// ProductUpdateInput"). Las opciones se gestionan con mutations separadas:
// productOptionsCreate, productOptionUpdate y productOptionDelete.
//
// Lo que se hace aquí: comparar opciones y registrar el cambio en changedFields
// para trazabilidad en logs, sin incluir el campo en el payload enviado a
// PRODUCT_UPDATE. La sincronización real de opciones huérfanas se delega a
// Shopify de forma implícita: cuando una variante con una opción determinada
// se elimina (por out_of_stock o por desaparecer del feed), Shopify elimina
// automáticamente el valor de opción si no queda ninguna variante que lo use.
export function computeProductUpdate(existingProduct, desiredProduct) {
  const product = { id: existingProduct.id };
  const changedFields = [];

  if (normalizeTextField(existingProduct?.title) !== normalizeTextField(desiredProduct?.title)) {
    product.title = desiredProduct.title;
    changedFields.push("title");
  }
  if (normalizeTextField(existingProduct?.vendor) !== normalizeTextField(desiredProduct?.vendor)) {
    product.vendor = desiredProduct.vendor;
    changedFields.push("vendor");
  }
  if (normalizeTextField(existingProduct?.descriptionHtml) !== normalizeTextField(desiredProduct?.descriptionHtml)) {
    product.descriptionHtml = desiredProduct.descriptionHtml;
    changedFields.push("descriptionHtml");
  }

  const existingTags = normalizeTags(existingProduct?.tags || []);
  const desiredTags = normalizeTags(desiredProduct?.tags || []);
  if (JSON.stringify(existingTags) !== JSON.stringify(desiredTags)) {
    product.tags = desiredProduct.tags || [];
    changedFields.push("tags");
  }

  // Comparar productOptions para detectar si han cambiado capacidades,
  // colores o condiciones disponibles.
  // ── IMPORTANTE ── Shopify NO acepta productOptions dentro de productUpdate.
  // La API requiere mutations separadas (productOptionsCreate / productOptionUpdate
  // / productOptionDelete) para modificar opciones de un producto existente.
  // Por eso registramos el cambio en changedFields (útil para logs y para que
  // el caller sepa que las opciones han cambiado) pero NO lo incluimos en el
  // payload `product` que se envía a PRODUCT_UPDATE.
  // Si en el futuro se implementa la sincronización de opciones, habría que
  // hacer una llamada adicional con las mutations correspondientes.
  const serializeOptions = (opts = []) =>
    JSON.stringify(
      [...(opts || [])].map(o => ({
        name: normalizeString(o.name),
        values: [...(o.values || o.optionValues || [])].map(v => normalizeString(v.name)).sort()
      })).sort((a, b) => a.name.localeCompare(b.name))
    );

  const existingOptionsStr = serializeOptions(existingProduct?.options);
  const desiredOptionsStr = serializeOptions(desiredProduct?.productOptions);

  if (existingOptionsStr !== desiredOptionsStr) {
    // Solo registrar el cambio, no añadir productOptions al payload
    changedFields.push("productOptions");
  }

  return { product, changedFields };
}

// ── CAMBIO 9 ── No enviar mediaId: null al payload de la mutación.
// Cuando imageMap no tiene entrada para la imagen de la variante
// (por fallo de matching o timeout de Shopify), enviar mediaId: null
// hace que Shopify desvincule la imagen que ya tuviera esa variante,
// dejándola sin foto aunque la imagen exista en el producto.
// Solución: omitir el campo mediaId completamente si no tenemos un ID
// válido. Shopify conserva la imagen anterior si el campo no se envía.
export function convertVariantForShopify(newVar, imageMap) {
  const barcode = isUsableIdentifier(newVar?.barcode)
    ? String(newVar.barcode).trim()
    : null;

  const resolvedMediaId = imageMap[newVar.image] || null;

  return {
    sku: newVar.sku,
    barcode,
    price: newVar.price,
    inventoryPolicy: "CONTINUE",
    optionValues: (newVar.optionValues || []).map(ov => ({
      optionName: ov.optionName,
      name: ov.name
    })),
    ...(resolvedMediaId ? { mediaId: resolvedMediaId } : {})
  };
}

// Elimina campos internos antes de enviar una variante a GraphQL.
export function sanitizeVariantForGraphQL(v) {
  const { normalizedOptions, currentMediaId, image, ...clean } = v;
  return clean;
}

// Construye el objeto de producto completo para la API de Shopify a partir
// de un grupo de items del feed.
export function buildShopifyProductObject(group, aiDescription = null) {
  const base = group[0];
  const normalizedBrand = normalizeBrand(base.brand);
  const so = normalizedBrand === 'apple' ? 'iOS' : 'Android';

  const PRICE_MARGIN = { apple: 70, default: 60 };
  const CONDITION = { new: "nuevo", refurbished: "reacondicionado", used: "usado" };
  const CONDITION_ES = { new: "nuevo", refurbished: "reacondicionado", used: "usado" };

  const margin = normalizedBrand === 'apple' ? PRICE_MARGIN.apple : PRICE_MARGIN.default;
  const title = base.modelTitle;

  const filteredItems = group.filter(v => {
    const price = Number(v.price) || 0;
    const minPrice = so === 'iOS' ? 219 : 180;
    const capacity = String(v.capacity || "").toUpperCase().replace(/\s+/g, "");
    const is64 = /^64(?:GB)?$/i.test(capacity);
    return price >= minPrice && !is64;
  });

  // ── CAMBIO 3 ── Deduplicar variantes con idéntica combinación de
  // capacity + color + condition antes de construir el producto.
  // Al agrupar por modelKey (CAMBIO 2), un mismo modelo puede tener
  // varios SKUs con exactas mismas opciones (unidades físicas distintas
  // del proveedor). Shopify rechaza esto con "Duplicated input value".
  // Nos quedamos con el SKU de mayor precio dentro de cada combinación.
  const seenCombos = new Map();
  for (const v of filteredItems) {
    const combo = `${v.capacity}|${v.color}|${v.condition}`;
    if (!seenCombos.has(combo) || v.price > seenCombos.get(combo).price) {
      seenCombos.set(combo, v);
    }
  }

  const hasAnyCapacity = filteredItems.some(v => v.capacity);
  const validItems = Array.from(seenCombos.values())
    .filter(v => !hasAnyCapacity || v.capacity);

  const capacities = uniqStrings(validItems.map(v => v.capacity)).filter(Boolean).sort(sortCapacities);
  const colors = uniqStrings(validItems.map(v => v.color));
  const conditions = uniqStrings(validItems.map(v => v.condition));
  const description = aiDescription || "";

  const tags = uniqStrings([
    normalizedBrand,
    so.toLowerCase(),
    'cosladafon',
    normalizeString(base.modelKey),
    ...conditions.map(c => CONDITION_ES[normalizeString(c)] || normalizeString(c))
  ]);

  const images = uniqStrings(validItems.map(v => v.image)).map(src => ({ originalSrc: src }));

  const variants = validItems
    .filter(v => Math.round((parseFloat(v.price) + margin) * 100) / 100 > 0)
    .map(v => {
      const variant = {
        sku: v.sku,
        barcode: isUsableIdentifier(v.gtin) ? String(v.gtin).trim() : null,
        price: Math.round((parseFloat(v.price) + margin) * 100) / 100,
        inventoryPolicy: "CONTINUE",
        optionValues: [
          v.capacity  ? { optionName: "Capacidad", name: v.capacity }                             : null,
          v.color     ? { optionName: "Color",     name: v.color }                                : null,
          v.condition ? { optionName: "Condición", name: CONDITION[v.condition] || v.condition }  : null,
        ].filter(Boolean),
        image: v.image || null
      };
      variant.normalizedOptions = normalizeOptions(variant.optionValues);
      return variant;
    });

  return {
    title,
    tags,
    vendor: "SecondTech",
    descriptionHtml: buildDescriptionHtml(title, description, conditions),
    productOptions: [
      capacities.length  ? { name: "Capacidad", values: capacities.map(c => ({ name: c })) }                 : null,
      colors.length      ? { name: "Color",     values: colors.map(c => ({ name: c })) }                     : null,
      conditions.length  ? { name: "Condición", values: conditions.map(c => ({ name: CONDITION[c] || c })) } : null,
    ].filter(Boolean),
    images,
    variants
  };
}