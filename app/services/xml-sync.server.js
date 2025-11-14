// =============================================================================
// XML SYNC → SHOPIFY (Versión corregida, estable y legible)
// =============================================================================

import { XMLParser } from "fast-xml-parser";
import { sendProgressEvent } from "../routes/api.sync-events.jsx";

// =============================================================================
// CONFIG
// =============================================================================
// Agregar configuración para procesamiento paralelo
const CONFIG = {
  RATE_LIMIT_DELAY: 500, // Aumentado a 500ms entre lotes
  CACHE_ENABLED: true,
  RETRY_COUNT: 3,
  RETRY_BASE_DELAY_MS: 150,
  LOG: true,
  PARALLEL_BATCH_SIZE: 3, // Reducido a 3 productos simultáneos para evitar throttling
};

const log = (...args) => CONFIG.LOG && console.log(new Date().toISOString(), ...args);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Función auxiliar para manejar respuestas GraphQL de diferentes versiones del SDK
async function parseGraphQLResponse(response) {
  if (!response) {
    throw new Error('Respuesta GraphQL vacía');
  }
  
  // Si ya tiene data directamente, devolverlo
  if (response.data !== undefined) {
    return response;
  }
  
  // Si tiene método json(), es una respuesta HTTP
  if (response.json && typeof response.json === 'function') {
    return await response.json();
  }
  
  // Si es un string, intentar parsearlo
  if (typeof response === 'string') {
    try {
      return JSON.parse(response);
    } catch (e) {
      throw new Error(`No se pudo parsear respuesta GraphQL: ${response}`);
    }
  }
  
  // Caso no esperado
  throw new Error(`Formato de respuesta GraphQL no reconocido: ${typeof response}`);
}

// Helper para normalizar valores de capacidad
function normalizeCapacity(title) {
  if (!title) return "Estándar";
  
  const sizeMatch = title.match(/(\d+(?:GB|TB|ML|L))/i);
  if (!sizeMatch) return "Estándar";
  
  let capacity = sizeMatch[1];
  // Normalizar capitalización: Gb -> GB, Tb -> TB, etc.
  capacity = capacity.replace(/gb$/i, 'GB').replace(/tb$/i, 'TB').replace(/ml$/i, 'ML');
  
  return capacity;
}

// Función para buscar productos existentes en Shopify
async function findExistingProductByGroup(admin, itemGroupId, firstProductSku) {
  try {
    // Buscar por múltiples criterios para máxima precisión
    const searchQueries = [
      `sku:${itemGroupId}`,                    // Por item_group_id como SKU
      `barcode:${itemGroupId}`,               // Por item_group_id como barcode
      `sku:${firstProductSku}`,               // Por SKU del primer producto
      `barcode:${firstProductSku}`            // Por barcode del primer producto
    ].filter(Boolean); // Filtrar valores nulos

    for (const searchQuery of searchQueries) {
      const query = `
        query searchProducts($query: String!) {
          products(first: 5, query: $query) {
            edges {
              node {
                id
                title
                handle
                variants(first: 50) {
                  edges {
                    node {
                      id
                      sku
                      barcode
                      price
                      inventoryQuantity
                    }
                  }
                }
                images(first: 10) {
                  edges {
                    node {
                      id
                      url
                      altText
                    }
                  }
                }
              }
            }
          }
        }
      `;

      const response = await withRetry(() => admin.graphql(query, {
        variables: { query: searchQuery }
      }));

      const result = await parseGraphQLResponse(response);
      
      if (result.data?.products?.edges?.length > 0) {
        const product = result.data.products.edges[0].node;
        log(`✅ Producto existente encontrado: ${product.title} (${product.id})`);
        return product;
      }
    }

    return null; // No encontrado
  } catch (error) {
    log(`❌ Error buscando producto existente:`, error);
    return null;
  }
}

// Función para actualizar producto existente con gestión completa de imágenes
async function updateExistingProduct(admin, existingProduct, newVariants, sendProgressEvent) {
  try {
    log(`🔄 Actualizando producto existente: ${existingProduct.title}`);
    
    const baseVariant = newVariants[0];
    const productId = existingProduct.id;
    
    // === PASO 1: ANÁLISIS DE CAMBIOS ===
    log(`📊 Analizando cambios necesarios...`);
    
    // Verificar si hay cambios en el título o descripción del producto base
    const needsProductUpdate = existingProduct.title !== baseVariant.title;
    
    // === PASO 2: GESTIÓN COMPLETA DE MEDIOS ===
    log(`🖼️ Procesando imágenes de producto y variantes...`);
    
    const mediaIdMap = new Map();
    const existingImages = new Map(); // URL -> MediaId de imágenes existentes
    
    // Mapear imágenes existentes en el producto
    if (existingProduct.images?.edges) {
      existingProduct.images.edges.forEach(edge => {
        const imageNode = edge.node;
        if (imageNode.url) {
          existingImages.set(imageNode.url, imageNode.id);
        }
      });
    }
    
    // Recolectar todas las URLs de imagen únicas de las nuevas variantes
    const allNewImageUrls = new Set();
    newVariants.forEach(variant => {
      if (variant.image_link) {
        allNewImageUrls.add(variant.image_link);
      }
    });
    
    log(`📸 Encontradas ${allNewImageUrls.size} imágenes únicas en variantes`);
    log(`📸 Producto tiene ${existingImages.size} imágenes existentes`);
    
    // Crear medios para imágenes nuevas que no existen
    for (const imageUrl of allNewImageUrls) {
      if (existingImages.has(imageUrl)) {
        // La imagen ya existe, usar el ID existente
        mediaIdMap.set(imageUrl, existingImages.get(imageUrl));
        log(`♻️ Reutilizando imagen existente: ${imageUrl}`);
      } else {
        // Crear nueva imagen
        try {
          new URL(imageUrl); // Validar URL
          
          const mediaResponse = await withRetry(() =>
            admin.graphql(PRODUCT_CREATE_MEDIA, {
              variables: {
                productId: productId,
                media: [{
                  originalSource: imageUrl,
                  alt: `Imagen del producto - ${imageUrl.split('/').pop()}`.slice(0, 120),
                  mediaContentType: "IMAGE"
                }]
              }
            })
          );
          
          const mediaData = await parseGraphQLResponse(mediaResponse);
          const mediaErrors = mediaData?.data?.productCreateMedia?.mediaUserErrors || [];
          
          if (mediaErrors.length === 0) {
            const createdMedia = mediaData?.data?.productCreateMedia?.media?.[0];
            if (createdMedia?.id) {
              mediaIdMap.set(imageUrl, createdMedia.id);
              log(`✅ Nueva imagen creada: ${imageUrl}`);
            }
          } else {
            log(`❌ Error creando imagen ${imageUrl}:`, mediaErrors);
          }
        } catch (error) {
          log(`⚠️ URL de imagen inválida: ${imageUrl}`);
        }
      }
    }
    
    // === PASO 3: ACTUALIZACIÓN DEL PRODUCTO BASE (SI ES NECESARIO) ===
    if (needsProductUpdate) {
      log(`📝 Actualizando información del producto base...`);
      
      try {
        const productUpdateQuery = `
          mutation productUpdate($input: ProductInput!) {
            productUpdate(input: $input) {
              product {
                id
                title
                description
              }
              userErrors {
                field
                message
              }
            }
          }
        `;
        
        const updateResponse = await withRetry(() => admin.graphql(productUpdateQuery, {
          variables: {
            input: {
              id: productId,
              title: baseVariant.title,
              descriptionHtml: baseVariant.description || ""
            }
          }
        }));
        
        const updateResult = await parseGraphQLResponse(updateResponse);
        const updateErrors = updateResult?.data?.productUpdate?.userErrors || [];
        
        if (updateErrors.length === 0) {
          log(`✅ Producto base actualizado`);
        } else {
          log(`⚠️ Errores actualizando producto base:`, updateErrors);
        }
      } catch (error) {
        log(`❌ Error actualizando producto base:`, error);
      }
    }
    
    // === PASO 4: PROCESAMIENTO AVANZADO DE VARIANTES ===
    log(`🔧 Procesando ${newVariants.length} variantes...`);
    
    const variantsToUpdate = [];
    let updatedVariantsCount = 0;
    let createdVariantsCount = 0;
    
    for (const newVariant of newVariants) {
      const existingVariant = findMatchingVariant(existingProduct.variants.edges, newVariant);
      
      // Preparar input de variante con gestión completa de opciones
      const capacityValue = normalizeCapacity(newVariant.title);
      const CONDITIONS = { "new": "Nuevo", "refurbished": "Reacondicionado", "used": "Usado" };
      const conditionValue = CONDITIONS[newVariant.condition] || "Nuevo";

      const optionValues = [
        { optionName: "Capacidad", name: capacityValue },
        { optionName: "Condición", name: conditionValue }
      ];

      // Agregar color si existe
      if (newVariant.color) {
        optionValues.push({ optionName: "Color", name: newVariant.color });
      }
      
      const variantInput = {
        price: parseFloat(newVariant.price).toFixed(2),
        sku: newVariant.sku ? newVariant.sku.toString() : undefined,
        inventoryPolicy: "CONTINUE",
        optionValues: optionValues
      };

      // Agregar barcode si está disponible
      if (newVariant.gtin && /^[0-9]{8,}$/.test(newVariant.gtin.toString())) {
        variantInput.barcode = newVariant.gtin.toString();
      }

      // Asignar imagen específica de la variante si existe
      if (newVariant.image_link && mediaIdMap.has(newVariant.image_link)) {
        variantInput.mediaId = mediaIdMap.get(newVariant.image_link);
        log(`🖼️ Imagen asignada a variante ${newVariant.sku}: ${newVariant.image_link}`);
      }
      
      if (existingVariant) {
        variantInput.id = existingVariant.node.id;
        updatedVariantsCount++;
        log(`🔄 Actualizando variante existente: ${newVariant.sku}`);
      } else {
        createdVariantsCount++;
        log(`➕ Creando nueva variante: ${newVariant.sku}`);
      }

      variantsToUpdate.push(variantInput);
    }
    
    // === PASO 5: APLICAR CAMBIOS CON PRODUCT SET ===
    log(`💾 Aplicando cambios: ${updatedVariantsCount} actualizaciones, ${createdVariantsCount} nuevas`);
    
    // Usar createProductVariants mejorado que ya tiene toda la lógica de filtrado
    const result = await createProductVariants(admin, { id: productId }, newVariants, sendProgressEvent);
    
    if (result.success) {
      log(`✅ Producto actualizado exitosamente`);
      // Obtener el producto actualizado desde Shopify
      let updatedProduct = null;
      try {
        const GET_UPDATED_PRODUCT = `
          query getUpdatedProduct($id: ID!) {
            product(id: $id) {
              id
              title
              vendor
              tags
              description
              variants(first: 50) {
                edges {
                  node {
                    id
                    sku
                    barcode
                    price
                    selectedOptions {
                      name
                      value
                    }
                  }
                }
              }
              images(first: 10) {
                edges {
                  node {
                    url
                    altText
                  }
                }
              }
            }
          }
        `;
        const productResponse = await withRetry(() => admin.graphql(GET_UPDATED_PRODUCT, {
          variables: { id: productId }
        }));
        const productData = await parseGraphQLResponse(productResponse);
        updatedProduct = productData?.data?.product || null;
      } catch (err) {
        log(`⚠️ No se pudo obtener el producto actualizado:`, err.message);
      }
      return {
        success: true,
        variantsUpdated: updatedVariantsCount,
        variantsCreated: createdVariantsCount,
        imagesProcessed: mediaIdMap.size,
        product: updatedProduct
      };
    } else {
      log(`❌ Error actualizando producto:`, result.error);
      return {
        success: false,
        error: result.error,
        variantsUpdated: 0,
        variantsCreated: 0
      };
    }

  } catch (error) {
    log(`❌ Error en updateExistingProduct:`, error);
    return {
      success: false,
      error: error.message,
      variantsUpdated: 0,
      variantsCreated: 0
    };
  }
}

// Función auxiliar para encontrar variante coincidente
function findMatchingVariant(existingVariants, newVariant) {
  return existingVariants.find(edge => {
    const existing = edge.node;
    
    // Buscar por SKU (más confiable)
    if (existing.sku && newVariant.sku && existing.sku === newVariant.sku) {
      return true;
    }
    
    // Buscar por barcode/GTIN
    if (existing.barcode && newVariant.gtin && existing.barcode === newVariant.gtin.toString()) {
      return true;
    }
    
    return false;
  });
}

async function withRetry(fn, retries = CONFIG.RETRY_COUNT) {
  let attempt = 0;
  while (attempt < retries) {
    try {
      return await fn();
    } catch (err) {
      attempt++;
      
      // Detección específica de throttling
      const isThrottled = err.message?.includes('Throttled') || 
                         err.message?.includes('throttle') ||
                         err.message?.includes('rate limit') ||
                         err.status === 429;
      
      if (attempt >= retries) throw err;
      
      // Delay más largo para throttling
      const baseDelay = isThrottled ? CONFIG.RETRY_BASE_DELAY_MS * 4 : CONFIG.RETRY_BASE_DELAY_MS;
      const delay = baseDelay * Math.pow(2, attempt - 1);
      
      log(`⚠️ Retry ${attempt}/${retries} after ${delay}ms - ${err.message}${isThrottled ? ' [THROTTLING]' : ''}`);
      await sleep(delay);
    }
  }
}

// =============================================================================
// XML PARSE + NORMALIZATION
// =============================================================================

function mapAvailability(av) {
  const a = av?.toLowerCase();
  if (a === "in_stock" || a === "available")
    return { status: "active", inventoryPolicy: "CONTINUE" };

  if (a === "preorder" || a === "coming_soon" || a === "new")
    return { status: "active", inventoryPolicy: "CONTINUE", tags: ["preorder"] };

  return { status: "draft", inventoryPolicy: "DENY" };
}

function parseXmlProduct(item) {
  const availabilityInfo = mapAvailability(item["g:availability"]);

  // ============================================
  // SKU: prioridad → GTIN > MPN > g:id
  // ============================================
  const sku = item["g:id"];

  // ============================================
  // TAGS
  // ============================================
  const tags = [];

  // Tags de disponibilidad (preorder)
  if (availabilityInfo.tags) tags.push(...availabilityInfo.tags);

  // Marca
  if (item["g:brand"] && typeof item["g:brand"] === "string") {
    const brandTag = item['g:brand'].toLowerCase() === 'apple' ? 'Apple' : 'Android';

    tags.push(brandTag);
  }

  // Condición → etiquetas normalizadas
  const condition = item["g:condition"]?.toLowerCase();
  if (condition) {
    // tags traducidos
    switch (condition) {
      case "new":
        tags.push("nuevo");
        break;
      case "refurbished":
        tags.push("reacondicionado");
        break;
      case "used":
        tags.push("usado");
        break;

      default:
        tags.push(condition);
    }
  }

  let rawPrice = item["g:price"] || "";
  rawPrice = rawPrice.trim();
  if (rawPrice.includes(" ")) {
    rawPrice = rawPrice.split(" ")[0];
  }
  rawPrice = rawPrice.replace(/,/, ".");
  rawPrice = rawPrice.replace(/[^\d.]/g, "");
  const parts = rawPrice.split('.');
  if (parts.length > 2) {
    rawPrice = parts[0] + '.' + parts.slice(1).join('');
  }
  const price = (!isNaN(parseFloat(rawPrice)) && parseFloat(rawPrice) > 0) ? parseFloat(rawPrice) : null;

  log(`Parsed price: "${item["g:price"]}" -> ${price}`);
  // ============================================
  // Producto normalizado
  // ============================================
  return {
    id: item["g:id"] || null,
    title: item["g:title"] || "Producto sin título",
    description: item["g:description"].replace('Cosladafon', 'Secondtech') || "",
    // vendor: item["g:brand"] || "Proveedor",
    vendor: "Cosladafon",
    brand: item["g:brand"] || "",
    condition: item["g:condition"] || "",
    price,
    gtin: item["g:gtin"] || null,
    sku,
    item_group_id: item["g:item_group_id"] || null,
    image_link: item["g:image_link"] || null,
    availability: item["g:availability"] || "unknown",
    color: item["g:color"] || "",
    category: item["g:product_type"] || "",
    tags,
    status: availabilityInfo.status,
    inventoryPolicy: availabilityInfo.inventoryPolicy,
  };
}


// =============================================================================
// SHOPIFY QUERIES
// =============================================================================
const FIND_PRODUCT_QUERY = `
  query findProduct($query: String!, $first: Int!) {
    products(first: $first, query: $query) {
      edges {
        node {
          id
          title
          vendor
          tags
          description
          variants(first: 50) {
            edges { 
              node { 
                id 
                sku 
                barcode 
                price 
              } 
            }
          }
          images(first: 10) {
            edges { 
              node { 
                url
                altText 
              } 
            }
          }
        }
      }
    }
  }
`;

const PRODUCT_CREATE = `
  mutation createProduct($product: ProductCreateInput!) {
    productCreate(product: $product) {
      product { 
        id 
        title 
        handle 
        variants(first: 10) {
          edges {
            node {
              id
              sku
              barcode
              price
            }
          }
        }
      }
      userErrors { field message }
    }
  }
`;

const PRODUCT_CREATE_MEDIA = `
  mutation productCreateMedia($media: [CreateMediaInput!]!, $productId: ID!) {
    productCreateMedia(media: $media, productId: $productId) {
      media {
        alt
        mediaContentType
        status
      }
      mediaUserErrors {
        field
        message
      }
      product {
        id
        title
      }
    }
  }
`;

const PRODUCT_SET = `
  mutation productSet($input: ProductSetInput!) {
    productSet(input: $input) {
      product {
        id
        title
        handle
        vendor
        status
        variants(first: 50) {
          edges {
            node {
              id
              title
              sku
              barcode
              price
              selectedOptions {
                name
                value
              }
            }
          }
        }
      }
      userErrors { 
        field 
        message 
      }
    }
  }
`;

// =============================================================================
// VARIANT GROUPING AND IMAGE HANDLING
// =============================================================================

/**
 * Agrupa productos por item_group_id para identificar variantes
 * @param {Array} products - Lista de productos parseados del XML
 * @returns {Map} - Mapa con clave=item_group_id, valor=array de productos
 */
function groupProductsByVariants(products) {
  const groups = new Map();
  const standalone = [];
  
  for (const product of products) {
    if (product.item_group_id) {
      if (!groups.has(product.item_group_id)) {
        groups.set(product.item_group_id, []);
      }
      groups.get(product.item_group_id).push(product);
    } else {
      standalone.push(product);
    }
  }
  
  // Agregar productos independientes como grupos de 1
  standalone.forEach(product => {
    groups.set(`standalone_${product.id}`, [product]);
  });
  
  if (CONFIG.LOG) {
    log(`📊 Grupos de variantes encontrados: ${groups.size}`);
    log(`📦 Productos con variantes: ${[...groups.values()].reduce((acc, group) => acc + group.length, 0)}`);
  }
  
  return groups;
}

/**
 * Determina qué producto debe ser el "maestro" de un grupo de variantes
 * @param {Array} variants - Lista de variantes del mismo grupo
 * @returns {Object} - El producto que servirá como base
 */
function selectMasterProduct(variants) {
  // Criterios de prioridad:
  // 1. Producto con menor precio (más atractivo)
  // 2. Producto "in_stock" sobre "out_of_stock"
  // 3. Primer producto alfabéticamente por título
  
  return variants.sort((a, b) => {
    // 1. Prioridad por disponibilidad
    if (a.availability === "in_stock" && b.availability !== "in_stock") return -1;
    if (b.availability === "in_stock" && a.availability !== "in_stock") return 1;
    
    // 2. Prioridad por precio (menor precio primero)
    if (a.price !== b.price) return a.price - b.price;
    
    // 3. Orden alfabético por título
    return a.title.localeCompare(b.title);
  })[0];
}

/**
 * Crea input de medios para Shopify desde URLs de imágenes
 * @param {Array} variants - Lista de variantes con sus imágenes
 * @returns {Array} - Array de CreateMediaInput válidos según la API oficial
 */
function createMediaInput(variants) {
  const mediaList = [];
  const seenImages = new Set();
  
  for (const variant of variants) {
    if (variant.image_link && !seenImages.has(variant.image_link)) {
      seenImages.add(variant.image_link);
      
      // Validar que la URL sea válida
      try {
        new URL(variant.image_link);
        
        mediaList.push({
          originalSource: variant.image_link,  // Campo oficial de la API
          alt: `${variant.title} - ${variant.color || 'Imagen del producto'}`.slice(0, 120), // Limitar longitud
          mediaContentType: "IMAGE"
        });
      } catch (error) {
        log(`⚠️ URL de imagen inválida ignorada: ${variant.image_link}`);
      }
    }
  }
  
  if (CONFIG.LOG && mediaList.length > 0) {
    log(`🖼️ ${mediaList.length} imágenes preparadas para el producto`);
  }
  
  return mediaList;
}

/**
 * Agrega imágenes a un producto existente usando productCreateMedia
 * @param {Object} admin - Cliente admin de Shopify
 * @param {string} productId - ID del producto 
 * @param {Array} variants - Lista de variantes con imágenes
 * @returns {Object} - Resultado de la operación
 */
async function addProductImages(admin, productId, variants) {
  const mediaInput = createMediaInput(variants);
  
  if (mediaInput.length === 0) {
    return { success: true, message: "No hay imágenes que agregar" };
  }

  if (CONFIG.LOG) {
    log(`🖼️ Agregando ${mediaInput.length} imágenes al producto ${productId}`);
  }

  try {
    const rawResponse = await withRetry(() =>
      admin.graphql(PRODUCT_CREATE_MEDIA, {
        variables: {
          productId: productId,
          media: mediaInput
        }
      })
    );

    const responseData = await parseGraphQLResponse(rawResponse);
    
    const errors = responseData?.data?.productCreateMedia?.mediaUserErrors || [];
    if (errors.length) {
      log(`❌ Error agregando imágenes:`, errors);
      return { success: false, error: errors };
    }

    const addedMedia = responseData?.data?.productCreateMedia?.media || [];
    
    if (CONFIG.LOG) {
      log(`✅ ${addedMedia.length} imágenes agregadas exitosamente`);
    }

    return { success: true, media: addedMedia };
    
  } catch (error) {
    log(`💥 Error agregando imágenes: ${error.message}`);
    return { success: false, error: error.message };
  }
}

/**
 * Crea opciones de producto basadas en las diferencias entre variantes
 * @param {Array} variants - Lista de variantes del mismo grupo
 * @returns {Array} - Array de opciones para ProductCreateInput
 */
function createProductOptions(variants) {
  const options = [];
  const colorSet = new Set();
  const sizeSet = new Set();
  const conditionSet = new Set();
  
  // Extraer valores únicos de las variantes
  variants.forEach(variant => {
    if (variant.color) colorSet.add(variant.color);
    
    // Extraer capacidad/tamaño del título (ej: "256GB", "512GB")
    const capacityValue = normalizeCapacity(variant.title);
    sizeSet.add(capacityValue);
    
    if (variant.condition) {
      conditionSet.add(variant.condition);
    } else {
      // Si no hay condición, usar "new" por defecto
      conditionSet.add("new");
    }
  });
  
  // Crear opciones solo si hay variación para el color
  if (colorSet.size > 1) {
    options.push({
      name: "Color",
      values: Array.from(colorSet).map(color => ({ name: color }))
    });
  }
  
  // SIEMPRE incluir Capacidad (obligatorio)
  options.push({
    name: "Capacidad", 
    values: Array.from(sizeSet).map(size => ({ name: size }))
  });
  
  // SIEMPRE incluir Condición (obligatorio)
  const CONDITIONS_DISPLAY = {
    "new": "Nuevo",
    "refurbished": "Reacondicionado", 
    "used": "Usado"
  };
  
  options.push({
    name: "Condición",
    values: Array.from(conditionSet).map(condition => ({ 
      name: CONDITIONS_DISPLAY[condition] || condition 
    }))
  });
  
  if (CONFIG.LOG && options.length > 0) {
    log(`🎯 ${options.length} opciones de producto creadas:`, options.map(o => `${o.name} (${o.values.length} valores)`));
  }
  
  return options;
}

// =============================================================================
// SHOPIFY SEARCH QUERY BUILDER
// =============================================================================

function sanitize(value) {
  if (!value) return "";
  return value
    .toString()
    .replace(/["'\n\r\t]+/g, " ") // elimina comillas y saltos de línea
    .replace(/\s+/g, " ")         // normaliza espacios
    .trim();
}

function buildSearchQuery(p) {
  // Construir query siguiendo la documentación oficial de Shopify API
  // Campos válidos para productos: title, vendor, tag, product_type, status, created_at, updated_at
  // Los campos sku y barcode NO son directamente searchables en products
  
  // Prioridad 1: Buscar por vendor + título (más específico)
  if (p.vendor && p.vendor.trim() && p.title && p.title.trim()) {
    const cleanVendor = sanitize(p.vendor);
    const cleanTitle = sanitize(p.title);
    
    if (cleanVendor.length > 2 && cleanTitle.length > 3) {
      const query = `vendor:${cleanVendor} title:${cleanTitle}`;
      if (CONFIG.LOG) {
        log(`🔍 Query construida por vendor+título: ${query}`);
      }
      return query;
    }
  }
  
  // Prioridad 2: Buscar solo por vendor (si es específico y sin espacios)
  if (p.vendor && p.vendor.trim()) {
    const cleanVendor = sanitize(p.vendor);
    if (cleanVendor.length > 3 && !cleanVendor.includes(' ')) {
      const query = `vendor:${cleanVendor}`;
      if (CONFIG.LOG) {
        log(`🔍 Query construida por vendor: ${query}`);
      }
      return query;
    }
  }

  // Prioridad 3: Buscar por título (si es específico)
  if (p.title && p.title.trim()) {
    const cleanTitle = sanitize(p.title);
    if (cleanTitle.length > 5) {
      // Usar solo las primeras palabras del título para evitar búsquedas demasiado específicas
      const titleWords = cleanTitle.split(' ').slice(0, 3).join(' ');
      const query = `title:${titleWords}`;
      if (CONFIG.LOG) {
        log(`🔍 Query construida por título: ${query}`);
      }
      return query;
    }
  }

  // Si no hay criterios válidos, no buscar
  if (CONFIG.LOG) {
    log(`⚠️ No se pudo construir query válida para: ${p.title || 'producto sin título'}`);
  }
  return null;
}

// =============================================================================
// PRODUCT SEARCH
// =============================================================================

async function findExistingProduct(admin, p, cache) {
  try {
    const query = buildSearchQuery(p);
    if (!query) {
      if (CONFIG.LOG) {
        log(`⚠️ No se pudo construir query válida para: ${p.title || 'producto sin título'}`);
      }
      return null;
    }
    
    if (CONFIG.CACHE_ENABLED && cache.has(query)) {
      if (CONFIG.LOG) {
        log(`💾 Cache hit para query: "${query}"`);
      }
      return cache.get(query);
    }
    
    if (CONFIG.LOG) {
      log(`🔍 Ejecutando búsqueda GraphQL: "${query}"`);
      log(`📊 Variables enviadas:`, { query: query, first: 5 });
    }
    
    // CORREGIDO: Pasar variables correctamente al GraphQL
    const rawResponse = await withRetry(() => admin.graphql(FIND_PRODUCT_QUERY, {
      variables: { 
        query: query, 
        first: 5 
      }
    }));
    
    // Parsear respuesta usando función auxiliar
    const data = await parseGraphQLResponse(rawResponse);
    
    // Verificar errores en la respuesta
    if (!data || data.errors) {
      if (CONFIG.LOG) {
        log(`❌ Error en respuesta GraphQL:`, data?.errors || 'No data');
      }
      return null;
    }
    
    const products = data.products?.edges || [];
    
    if (products.length > 0) {
      const foundProduct = products[0].node;
      if (CONFIG.CACHE_ENABLED) {
        cache.set(query, foundProduct);
      }
      if (CONFIG.LOG) {
        log(`✅ Producto existente encontrado: ${foundProduct.title} (ID: ${foundProduct.id})`);
      }
      return foundProduct;
    }
    
    if (CONFIG.CACHE_ENABLED) {
      cache.set(query, null);
    }
    
    if (CONFIG.LOG) {
      log(`❌ No se encontraron productos para: "${query}"`);
    }
    return null;
    
  } catch (error) {
    if (CONFIG.LOG) {
      log(`💥 Excepción en búsqueda: ${error.message}`);
      
      // Log adicional para debug
      if (error.response) {
        log(`� Detalles del error:`, error.response);
      }
      if (error.networkError) {
        log(`🌐 Error de red:`, error.networkError);
      }
      if (error.graphQLErrors) {
        log(`📝 Errores GraphQL:`, error.graphQLErrors);
      }
    }
    
    // En caso de error, tratar como producto nuevo
    return null;
  }
}

// =============================================================================
// PRODUCT CREATION WITH VARIANTS
// Publicar producto en los canales Online Store y Shop
async function publishProductToChannels(admin, productId) {
  if (!productId) {
    log('❌ No se puede publicar: productId es inválido o no está definido');
    return;
  }

  const gidProductId = productId.startsWith('gid://') 
    ? productId 
    : `gid://shopify/Product/${productId}`;

  // Obtener publicaciones
  const PUBLICATIONS_QUERY = `
    query publications {
      publications(first: 10) {
        edges {
          node {
            id
            name
          }
        }
      }
    }
  `;

  const pubsResponse = await withRetry(() => admin.graphql(PUBLICATIONS_QUERY));
  const pubsData = await parseGraphQLResponse(pubsResponse);
  
  const edges = pubsData?.data?.publications?.edges || [];
  const publicationIds = edges
    .filter(e => e.node.name === 'Online Store' || e.node.name === 'Shop')
    .map(e => e.node.id);

  if (!publicationIds.length) {
    log('⚠️ No se encontraron canales Online Store/Shop para publicar');
    return;
  }

  // ✅ MUTACIÓN CORRECTA (dos argumentos separados)
  const PUBLISH_MUTATION = `
    mutation publishablePublish($id: ID!, $input: [PublicationInput!]!) {
      publishablePublish(id: $id, input: $input) {
        userErrors { field message }
      }
    }
  `;

  try {
    // Preparar el array de inputs para cada publicación
    const publicationInputs = publicationIds.map(pubId => ({
      publicationId: pubId
    }));

    log(`🚀 Publicando producto ${gidProductId}`);
    
    const publishResponse = await admin.graphql(PUBLISH_MUTATION, {
      variables: { 
        id: gidProductId,           // Argumento directo
        input: publicationInputs    // Array de objetos PublicationInput
      }
    });
    
    const publishData = await parseGraphQLResponse(publishResponse);
    const errors = publishData?.data?.publishablePublish?.userErrors || [];
    
    if (errors.length) {
      log('⚠️ Errores publicando producto:', errors);
    } else {
      log(`✅ Producto publicado exitosamente`);
    }
  } catch (err) {
    log('❌ Excepción al publicar producto:', err.message);
  }
}
// =============================================================================

async function createShopifyProductWithVariants(admin, variants) {
  const masterProduct = selectMasterProduct(variants);
  const productOptions = createProductOptions(variants);
  
  // Preparar datos del producto base
  const title = sanitize(cleanProductTitleDynamic(masterProduct.title, variants)) || "Producto sin título";
  const vendor = sanitize(masterProduct.vendor) || "Sin marca";
  const description = sanitize(masterProduct.description) || "";
  
  // Validar precio
  const price = parseFloat(masterProduct.price);

  log(`🛠️ Creando producto: ${title} con ${price} precio`);
  if (isNaN(price) || price <= 0) {
    log(`❌ Precio inválido para ${title}: ${masterProduct.price}`);
    return { success: false, error: "Precio inválido" };
  }
  
  // ProductCreateInput con opciones y medios
  const productInput = {
    title: title,
    vendor: vendor,
    descriptionHtml: description,
    status: "ACTIVE",
    productType: sanitize(masterProduct.category) || "",
  };
  
  // Agregar opciones si hay variantes múltiples
  if (productOptions.length > 0) {
    productInput.productOptions = productOptions;
  }
  
  // Tags: combinar tags de todas las variantes
  const allTags = new Set();
  variants.forEach(variant => {
    if (variant.tags) {
      variant.tags.forEach(tag => allTags.add(sanitize(tag)));
    }
  });
  
  if (allTags.size > 0) {
    productInput.tags = Array.from(allTags).filter(tag => tag && tag.length > 0);
  }
  
  if (CONFIG.LOG) {
    log(`🔧 Creando producto con ${variants.length} variantes: ${title}`);
  }
  
  try {
    // Paso 1: Crear producto base
    const rawResponse = await withRetry(() =>
      admin.graphql(PRODUCT_CREATE, {
        variables: { 
          product: productInput
        }
      })
    );

    // Parsear respuesta usando función auxiliar
    const responseData = await parseGraphQLResponse(rawResponse);

    const errors = responseData?.data?.productCreate?.userErrors || [];
    if (errors.length) {
      log(`❌ Error creando producto ${title}:`, errors);
      return { success: false, error: errors.map(e => e.message).join("; "), product: null };
    }

    const createdProduct = responseData?.data?.productCreate?.product;
    if (!createdProduct || !createdProduct.id) {
      log(`❌ No se pudo crear el producto ${title}`);
      log(`🔍 responseData completo (variants):`, JSON.stringify(responseData, null, 2));
      return { success: false, error: "No se pudo crear el producto", product: null };
    }

    log(`✅ Producto base creado: ${createdProduct.title} (ID: ${createdProduct.id})`);

    // Paso 2: Agregar imágenes al producto
    const imagesResult = await addProductImages(admin, createdProduct.id, variants);
    if (!imagesResult.success) {
      log(`⚠️ Error agregando imágenes: ${imagesResult.error}`);
    }

    // Paso 3: Si hay múltiples variantes, establecer todas las variantes de una vez
    if (variants.length > 1) {
      await sleep(300); // pequeña espera para asegurar que Shopify registre las opciones

      const GET_PRODUCT_OPTIONS = `
        query getProductOptions($id: ID!) {
          product(id: $id) {
            id
            title
            options {
              name
              values
            }
          }
        }
      `;

      let variantsResult;
      
      try {
        const optionsResponse = await withRetry(() => admin.graphql(GET_PRODUCT_OPTIONS, {
          variables: { id: createdProduct.id },
        }));

        const optionsData = await parseGraphQLResponse(optionsResponse);
        const confirmedOptions = optionsData?.data?.product?.options || [];

        if (confirmedOptions.length > 0) {
          log(
            `✅ Opciones confirmadas desde Shopify: ${confirmedOptions
              .map((o) => o.name)
              .join(", ")}`
          );
          variantsResult = await createProductVariants(
            admin,
            { ...createdProduct, options: confirmedOptions },
            variants
          );
        } else {
          log("⚠️ No se encontraron opciones en Shopify; usando locales");
          variantsResult = await createProductVariants(admin, createdProduct, variants);
        }
      } catch (err) {
        log("⚠️ Error al confirmar opciones, usando locales:", err.message);
        variantsResult = await createProductVariants(admin, createdProduct, variants);
      }

      if (!variantsResult.success) {
        log(`⚠️ Error estableciendo variantes, pero producto base creado: ${variantsResult.error}`);
      } else {
        if (CONFIG.LOG) {
          log(`✅ ${variants.length} variantes establecidas correctamente con SKUs`);
        }
      }
    } else {
      // Para productos únicos, solo actualizar la variante por defecto
      if (createdProduct.variants?.edges?.length > 0) {
        const defaultVariant = createdProduct.variants.edges[0].node;
        await updateDefaultVariant(admin, defaultVariant.id, masterProduct, createdProduct.id);
      }
    }

    log(`🎉 Producto creado exitosamente: ${createdProduct.title} (ID: ${createdProduct.id})`);
    // Publicar el producto en los canales Online Store y Shop
    await publishProductToChannels(admin, createdProduct.id);

    // Obtener el producto actualizado desde Shopify para devolverlo
    let updatedProduct = null;
    try {
      const GET_UPDATED_PRODUCT = `
        query getUpdatedProduct($id: ID!) {
          product(id: $id) {
            id
            title
            vendor
            tags
            description
            variants(first: 50) {
              edges {
                node {
                  id
                  sku
                  barcode
                  price
                  selectedOptions {
                    name
                    value
                  }
                }
              }
            }
            images(first: 10) {
              edges {
                node {
                  url
                  altText
                }
              }
            }
          }
        }
      `;
      const productResponse = await withRetry(() => admin.graphql(GET_UPDATED_PRODUCT, {
        variables: { id: createdProduct.id }
      }));
      const productData = await parseGraphQLResponse(productResponse);
      updatedProduct = productData?.data?.product || null;
    } catch (err) {
      log(`⚠️ No se pudo obtener el producto actualizado:`, err.message);
    }

    return { success: true, product: updatedProduct };
  } catch (error) {
    log(`💥 Excepción creando producto ${title}:`, error.message);
    return { success: false, error: error.message, product: null };
  }
}

function variantExists(product, variant) {
  return product.variants?.edges.some(edge => {
    const existing = edge.node;
    // Comparar opciones
    if (!existing.selectedOptions) return false;

    return variant.optionValues.every(opt => 
      existing.selectedOptions.some(eo => eo.name === opt.optionName && eo.value === opt.name)
    );
  });
}

async function createProductVariants(admin, product, variants) {
  try {
    // 🔍 DEBUG: Log de entrada de createProductVariants
    log(`🎬 createProductVariants INICIADO - Producto: ${product.title || 'Sin título'}`);
    log(`📥 VARIANTS RECIBIDAS - Total: ${variants.length}`);
    variants.forEach((variant, i) => {
      log(`   📦 Variant ${i}: SKU=${variant.sku}, Color="${variant.color}", Título="${variant.title}", Precio="${variant.price}"`);
      if (!variant.price || isNaN(parseFloat(variant.price)) || parseFloat(variant.price) <= 0) {
        log(`   ⚠️ [PRECIO] Variante ${i} tiene precio inválido: "${variant.price}"`);
      }
    });
    
    // --- Obtener opciones completas del producto (con valores) ---
    let productOptions;
    if (product.options?.length) {
      // Si el producto ya tiene opciones, transformarlas al formato ProductSetInput
      productOptions = product.options.map(option => ({
        name: option.name,
        values: option.values.map(value => ({ name: value }))
      }));
    } else {
      // Si no tiene opciones, crearlas desde las variantes
      productOptions = createProductOptions(variants);
    }

    log(`🎯 ProductOptions completas:`, productOptions);
    
    // 🔍 DEBUG: Inspeccionar propiedades reales de las variantes
    log(`🔬 DEBUG VARIANTS - Total: ${variants.length}`);
    variants.forEach((variant, i) => {
      log(`   Variant ${i}:`, {
        title: variant.title,
        sku: variant.sku,
        condition: variant.condition,
        color: variant.color,
        colorType: typeof variant.color,
        hasColor: !!variant.color,
        colorLength: variant.color ? variant.color.length : 'undefined',
        colorTrimmed: variant.color ? variant.color.trim() : 'N/A',
        allProps: Object.keys(variant)
      });
    });
    
    // Verificar si necesita opción Color - CORRECCIÓN FINAL
    // Solo crear Color si hay variantes con colores REALES diferentes
    const validColors = variants.map(v => v.color).filter(c => c && c.trim() !== '');
    const uniqueValidColors = [...new Set(validColors)];
    const hasVariantsWithColor = uniqueValidColors.length > 0;
    const hasVariantsWithoutColor = variants.some(v => !v.color || v.color.trim() === '');
    
    // DECISIÓN: Solo crear opción Color si hay colores reales diferentes
    const needsColorOption = hasVariantsWithColor && uniqueValidColors.length > 1;
    const hasColorOption = productOptions.some(o => o.name === "Color");
    
    log(`🎨 COLOR DETECTION FINAL:`, {
      needsColorOption,
      hasColorOption,
      hasVariantsWithColor,
      hasVariantsWithoutColor,
      validColors: uniqueValidColors,
      totalVariants: variants.length,
      reasoning: needsColorOption ? 
        `Creando opción Color porque hay ${uniqueValidColors.length} colores diferentes` :
        `NO creando opción Color porque ${!hasVariantsWithColor ? 'no hay colores válidos' : 'solo hay 1 color único'}`
    });
    
    // Añadir Color si es necesario - CORRECCIÓN FINAL
    // if (needsColorOption && !hasColorOption) {
    //   const uniqueValidColors = [...new Set(variants.map(v => v.color).filter(c => c && c.trim() !== ''))];
      
    //   // Solo añadir si hay colores reales válidos
    //   if (uniqueValidColors.length > 0) {
    //     productOptions.push({
    //       name: "Color",
    //       values: uniqueValidColors.map(color => ({ name: color }))
    //     });
    //     log(`🎨 Añadida opción 'Color' con ${uniqueValidColors.length} colores reales: ${uniqueValidColors.join(", ")}`);
    //   }
    // } else if (!needsColorOption) {
    //   log(`🚫 NO se añade opción Color - no hay suficientes colores diferentes para justificar la opción`);
    // }

    if (hasVariantsWithColor && !hasColorOption) {
      productOptions.push({
        name: "Color",
        values: uniqueValidColors.map(color => ({ name: color }))
      });
      log(`🎨 Añadida opción 'Color' con ${uniqueValidColors.length} colores reales: ${uniqueValidColors.join(", ")}`);
    }
    
    // 🔧 PRE-FILTRAR DUPLICADOS: TODAS las variantes (incluida la primera)
    const uniqueInputVariants = [];
    const seenInputKeys = new Set();
    
    log(`🔍 PRE-FILTRADO - Analizando TODAS las ${variants.length} variantes de entrada`);
    
    variants.forEach((variant, index) => {
      // Crear clave basada en las opciones que se van a generar
      const testCapacity = normalizeCapacity(variant.title);
      const testCondition = variant.condition ? 
        ({"new": "Nuevo", "refurbished": "Reacondicionado", "used": "Usado"}[variant.condition] || variant.condition) : 
        "Nuevo";
      
      // Si no tiene color, usar una clave única basada en el SKU para diferenciarlo
      let testColor = variant.color || "";
      if (!testColor || testColor.trim() === "") {
        // Para pre-filtrado: si no hay color, simplemente usar "Sin Color" 
        // No inventamos colores aquí, solo agrupamos las variantes sin color
        testColor = "Sin-Color";
      }
      
      const testKey = [
        `Capacidad:${testCapacity}`,
        `Condición:${testCondition}`,
        `Color:${testColor}`
      ].sort().join('|');
      
      if (seenInputKeys.has(testKey)) {
        log(`🚫 PRE-FILTRO: Eliminando variante duplicada ${index + 1}: ${testKey} (SKU: ${variant.sku})`);
        return;
      }
      
      log(`✅ PRE-FILTRO: Variante ${index + 1} es única: ${testKey} (SKU: ${variant.sku})`);
      seenInputKeys.add(testKey);
      uniqueInputVariants.push(variant);
    });
    
    log(`✅ PRE-FILTRADO - Variantes únicas de entrada: ${uniqueInputVariants.length}`);
    
    // Preparar variantes para bulk create (usando variantes ya filtradas)
    const variantsInput = uniqueInputVariants.map((variant, variantIndex) => {
      log(`🔧 Procesando variante ${variantIndex + 1}/${uniqueInputVariants.length}: SKU=${variant.sku}, Título="${variant.title}"`);

      // --- Opciones base: MISMO ORDEN que createProductOptions ---
      const optionValues = [];

      // 1. Color PRIMERO (SOLO si existe en las opciones del producto)
      const shouldAddColor = productOptions.some(o => o.name === "Color");
      if (shouldAddColor) {
        let colorValue = variant.color;
        
        // Si no tiene color pero la opción Color existe, usar el color que corresponda
        if (!colorValue || colorValue.trim() === "") {
          // Esta variante no debería estar aquí si no hay opción Color
          // Pero si está, significa que hay otras variantes con color válido
          log(`⚠️ Variante ${variant.sku} no tiene color pero el producto requiere opción Color - SALTEANDO`);
          return null; // Saltar esta variante
        }
        
        optionValues.push({ optionName: "Color", name: colorValue });
        log(`✅ Color agregado a variante ${variant.sku}: "${colorValue}"`);
      } else {
        // No hay opción Color en el producto, perfecto para variantes sin color
        log(`✅ No se requiere Color para variante ${variant.sku} (producto sin opción Color)`);
      }

      // 2. Capacidad (SIEMPRE incluir, pero posición depende de si hay Color)
      const capacityValue = normalizeCapacity(variant.title);
      log(`📏 Capacidad extraída: "${capacityValue}" de título "${variant.title}"`);
      optionValues.push({ optionName: "Capacidad", name: capacityValue });

      // 3. Condición (SIEMPRE incluir)
      const CONDITIONS = {
        "new": "Nuevo",
        "refurbished": "Reacondicionado",
        "used": "Usado"
      };
      const conditionValue = variant.condition ? 
        (CONDITIONS[variant.condition] || variant.condition) : 
        "Nuevo";
      optionValues.push({ optionName: "Condición", name: conditionValue });

      // Crear clave única para detectar duplicados
      const variantKey = optionValues.map(ov => `${ov.optionName}:${ov.name}`).sort().join('|');
      log(`🔑 Variante ${variantIndex + 1} key: "${variantKey}" (SKU: ${variant.sku})`);

      if (variantExists(product, { optionValues })) {
        log(`⚠️ Variante ${variantIndex + 1} ya existe en Shopify: ${optionValues.map(o => o.name).join(" / ")} (SKU: ${variant.sku})`);
        return null;
      }

      // --- Construir objeto variante SIN SKU (ProductVariantsBulkInput no lo soporta) ---
      const variantInput = {
        price: parseFloat(variant.price).toFixed(2), // siempre string con decimales
        inventoryPolicy: variant.inventoryPolicy || "CONTINUE",
      };

      // Barcode (GTIN)
      if (variant.gtin && /^[0-9]{8,}$/.test(variant.gtin.toString())) {
        variantInput.barcode = variant.gtin.toString();
      }

      // Opciones (siempre incluir al menos Capacidad y Condición)
      variantInput.optionValues = optionValues;

      // ✅ VALIDAR que cada optionValue existe en productOptions
      variantInput.optionValues.forEach((optionValue, ovIndex) => {
        const productOption = productOptions.find(po => po.name === optionValue.optionName);
        if (!productOption) {
          log(`❌ createProductVariants - optionValue ${ovIndex}: La opción "${optionValue.optionName}" no existe en productOptions`);
          throw new Error(`La opción "${optionValue.optionName}" no existe en productOptions`);
        }

        const valueExists = productOption.values.some(v => v.name === optionValue.name);
        if (!valueExists) {
          log(`❌ createProductVariants - optionValue ${ovIndex}: El valor "${optionValue.name}" no existe en la opción "${optionValue.optionName}"`);
          log(`📋 Valores disponibles: ${productOption.values.map(v => v.name).join(', ')}`);
          
          // Usar el primer valor disponible como fallback
          optionValue.name = productOption.values[0].name;
          log(`🔧 Usando fallback: "${optionValue.name}"`);
        }
      });

      // Imagen con estructura CreateMediaInput
      if (variant.image_link) {
        try {
          new URL(variant.image_link);
          variantInput.media = [{
            originalSource: variant.image_link,
            alt: `${variant.title} - ${variant.color || 'Imagen del producto'}`.slice(0, 120),
            mediaContentType: "IMAGE"
          }];
        } catch (error) {
          log(`⚠️ URL de imagen inválida ignorada para variante: ${variant.image_link}`);
        }
      }

      // Guardar el SKU para asignarlo después de la creación
      variantInput._pendingSku = variant.sku;

      return variantInput;
    }).filter(Boolean); // Eliminar nulos

    // Post-filtrar cualquier duplicado restante (por seguridad)
    const uniqueVariantsInput = [];
    const seenKeys = new Set();
    
    log(`🔍 POST-FILTRADO - Verificando ${variantsInput.length} variantes procesadas`);
    
    variantsInput.forEach((variantInput, index) => {
      if (!variantInput) return; // Skip null variants
      
      const variantKey = variantInput.optionValues
        .map(ov => `${ov.optionName}:${ov.name}`)
        .sort()
        .join('|');
        
      if (seenKeys.has(variantKey)) {
        log(`🚫 POST-FILTRO: Eliminando duplicado restante ${index + 1}: ${variantKey} (SKU pendiente: ${variantInput._pendingSku})`);
        return;
      }
      
      log(`✅ POST-FILTRO: Variante ${index + 1} es única: ${variantKey} (SKU pendiente: ${variantInput._pendingSku})`);
      seenKeys.add(variantKey);
      uniqueVariantsInput.push(variantInput);
    });
    
    log(`✅ POST-FILTRADO - Variantes finales: ${uniqueVariantsInput.length}`);

    if (uniqueVariantsInput.length === 0) {
      return { success: true }; // No hay variantes adicionales que crear
    }

    // --- Paso 1: Crear medios (imágenes) primero ---
    const masterVariant = variants[0]; // Primer elemento como variante principal
    const allVariants = [];
    const mediaIdMap = new Map(); // Para mapear URLs de imagen a IDs de media
    const allImageUrls = new Set();
    
    // Recolectar todas las URLs únicas de imágenes de todas las variantes
    [masterVariant, ...uniqueVariantsInput].forEach(variant => {
      const imageUrl = variant.image_link || variant._originalImageUrl;
      if (imageUrl) {
        allImageUrls.add(imageUrl);
        // Guardar la URL original en las variantes procesadas para referencia
        if (variant._pendingSku) {
          variant._originalImageUrl = imageUrl;
        }
      }
    });
    
    // Crear medios para todas las imágenes únicas
    for (const imageUrl of allImageUrls) {
      try {
        new URL(imageUrl); // Validar URL
        
        const mediaResponse = await withRetry(() =>
          admin.graphql(PRODUCT_CREATE_MEDIA, {
            variables: {
              productId: product.id,
              media: [{
                originalSource: imageUrl,
                alt: `Imagen del producto - ${imageUrl.split('/').pop()}`.slice(0, 120),
                mediaContentType: "IMAGE"
              }]
            }
          })
        );
        
        const mediaData = await parseGraphQLResponse(mediaResponse);
        const mediaErrors = mediaData?.data?.productCreateMedia?.mediaUserErrors || [];
        
        if (mediaErrors.length === 0) {
          const createdMedia = mediaData?.data?.productCreateMedia?.media?.[0];
          if (createdMedia?.id) {
            mediaIdMap.set(imageUrl, createdMedia.id);
            if (CONFIG.LOG) {
              log(`✅ Media creado: ${createdMedia.id} para ${imageUrl}`);
            }
          }
        } else {
          log(`❌ Error creando media para ${imageUrl}:`, mediaErrors);
        }
      } catch (error) {
        log(`⚠️ URL de imagen inválida ignorada: ${imageUrl}`);
      }
    }

    // --- Paso 2: Preparar variantes con mediaId ---
    // Incluir variante por defecto con datos completos
    const masterVariantInput = {
      price: parseFloat(masterVariant.price).toFixed(2),
      inventoryPolicy: masterVariant.inventoryPolicy || "CONTINUE",
      sku: masterVariant.sku ? sanitize(masterVariant.sku.toString()) : undefined,
      barcode: masterVariant.gtin && /^[0-9]{8,}$/.test(masterVariant.gtin.toString()) 
        ? masterVariant.gtin.toString() 
        : undefined,
      optionValues: []
    };
    
    // Generar opciones para la variante principal
    const capacityValue = normalizeCapacity(masterVariant.title);
    masterVariantInput.optionValues.push({ optionName: "Capacidad", name: capacityValue });
    
    const CONDITIONS = { "new": "Nuevo", "refurbished": "Reacondicionado", "used": "Usado" };
    const conditionValue = CONDITIONS[masterVariant.condition] || "Nuevo";
    masterVariantInput.optionValues.push({ optionName: "Condición", name: conditionValue });
    
    // Color: incluir si existe, o valor por defecto si Color está en productOptions
    if (masterVariant.color) {
      masterVariantInput.optionValues.push({ optionName: "Color", name: masterVariant.color });
    } else {
      // Se agregará después si es necesario cuando se verifiquen las productOptions
    }
    
    // Asignar mediaId si existe imagen para la variante principal
    if (masterVariant.image_link && mediaIdMap.has(masterVariant.image_link)) {
      masterVariantInput.mediaId = mediaIdMap.get(masterVariant.image_link);
    }

    // --- Paso 2.5: Filtrar duplicados finales incluyendo masterVariantInput ---
    // Combinar masterVariantInput con uniqueVariantsInput y eliminar duplicados
    const allVariantsData = [masterVariantInput, ...uniqueVariantsInput.map(variant => ({
      price: variant.price,
      inventoryPolicy: variant.inventoryPolicy,
      sku: variant._pendingSku ? sanitize(variant._pendingSku.toString()) : undefined,
      barcode: variant.barcode,
      optionValues: variant.optionValues,
      _originalImageUrl: variant._originalImageUrl
    }))];

    const finalSeenKeys = new Set();

    log(`🔍 FILTRADO FINAL - Verificando ${allVariantsData.length} variantes totales (incluyendo master)`);
    
    allVariantsData.forEach((variantData, index) => {
      const variantKey = variantData.optionValues
        .map(ov => `${ov.optionName}:${ov.name}`)
        .sort()
        .join('|');
        
      if (finalSeenKeys.has(variantKey)) {
        log(`🚫 FILTRADO FINAL: Eliminando duplicado ${index + 1}: ${variantKey} (SKU: ${variantData.sku})`);
        return;
      }
      
      log(`✅ FILTRADO FINAL: Variante ${index + 1} es única: ${variantKey} (SKU: ${variantData.sku})`);
      finalSeenKeys.add(variantKey);
      
      // Crear variante final con mediaId si existe
      const finalVariant = {
        price: variantData.price,
        inventoryPolicy: variantData.inventoryPolicy,
        sku: variantData.sku,
        barcode: variantData.barcode,
        optionValues: variantData.optionValues
      };
      
      // Asignar mediaId apropiadamente
      if (index === 0) {
        // Es masterVariant - usar su mediaId ya asignado
        if (masterVariantInput.mediaId) {
          finalVariant.mediaId = masterVariantInput.mediaId;
        }
      } else {
        // Es variante adicional - usar _originalImageUrl
        if (variantData._originalImageUrl && mediaIdMap.has(variantData._originalImageUrl)) {
          finalVariant.mediaId = mediaIdMap.get(variantData._originalImageUrl);
        }
      }
      
      allVariants.push(finalVariant);
    });
    
    log(`✅ FILTRADO FINAL - Variantes únicas finales: ${allVariants.length}`);

    // --- Paso 3: Preparar el input para productSet usando mediaId ---
    const finalProductOptions = createProductOptions(variants);
    const productSetInput = {
      id: product.id,
      productOptions: finalProductOptions,
      variants: allVariants.map(variant => {
        // Asegurar que cada variante tenga exactamente un valor para cada opción
        const completeOptionValues = finalProductOptions.map(productOption => {
          // Buscar si la variante ya tiene un valor para esta opción
          const existingValue = variant.optionValues.find(ov => ov.optionName === productOption.name);
          
          if (existingValue) {
            return existingValue;
          }
          
          // Si no tiene valor para esta opción, proporcionar valor por defecto
          if (productOption.name === "Color") {
            return { optionName: "Color", name: "Sin especificar" };
          }
          if (productOption.name === "Capacidad") {
            return { optionName: "Capacidad", name: "Estándar" };
          }
          if (productOption.name === "Condición") {
            return { optionName: "Condición", name: "Nuevo" };
          }
          
          // Fallback genérico
          return { optionName: productOption.name, name: "Sin especificar" };
        });
        
        return {
          price: variant.price,
          inventoryPolicy: variant.inventoryPolicy,
          sku: variant.sku.toString(),
          barcode: variant.barcode,
          optionValues: completeOptionValues,
          ...(variant.mediaId ? { mediaId: variant.mediaId } : {})
        };
      })
    };

    // Log crítico antes de productSet
    log(`🔍 PRODUCTSET INPUT - createProductVariants:`);
    log(`   ProductOptions: ${finalProductOptions.length} opciones - [${finalProductOptions.map(o => o.name).join(', ')}]`);
    log(`   Total Variants: ${productSetInput.variants.length} variantes`);
    productSetInput.variants.forEach((v, i) => {
      log(`   Variant ${i+1}: ${v.optionValues.length} optionValues - [${v.optionValues.map(ov => `${ov.optionName}=${ov.name}`).join(', ')}] (SKU: ${v.sku})`);
    });
    
    // NUEVO: Log detallado para detectar duplicados antes del envío
    log(`🔍 ANÁLISIS DETALLADO PRE-ENVÍO:`);
    const variantSignatures = productSetInput.variants.map((v, i) => {
      const signature = v.optionValues.map(ov => ov.name).join(' / ');
      log(`   Variante ${i+1}: "${signature}" (SKU: ${v.sku})`);
      return signature;
    });
    
    const duplicateSignatures = variantSignatures.filter((sig, idx) => 
      variantSignatures.indexOf(sig) !== idx
    );
    
    if (duplicateSignatures.length > 0) {
      log(`❌ ALERTA: ${duplicateSignatures.length} duplicados detectados después del completado de optionValues:`);
      duplicateSignatures.forEach(dup => {
        const indices = variantSignatures
          .map((sig, idx) => sig === dup ? idx : -1)
          .filter(idx => idx !== -1);
        log(`   → "${dup}" aparece en posiciones: ${indices.map(i => i+1).join(', ')}`);
        
        // Mostrar detalles de las variantes duplicadas
        indices.forEach(idx => {
          const variant = productSetInput.variants[idx];
          log(`     Posición ${idx+1}: SKU=${variant.sku}, Precio=$${variant.price}`);
        });
      });
      
      // CRÍTICO: Si hay duplicados después del completado, filtrarlos ahora
      log(`🚨 FILTRANDO DUPLICADOS DESPUÉS DEL COMPLETADO...`);
      const seenSignatures = new Set();
      const uniqueVariants = [];
      
      productSetInput.variants.forEach(variant => {
        const signature = variant.optionValues.map(ov => ov.name).join(' / ');
        if (seenSignatures.has(signature)) {
          log(`   🚫 Eliminando duplicado final: "${signature}" (SKU: ${variant.sku})`);
          return;
        }
        log(`   ✅ Manteniendo: "${signature}" (SKU: ${variant.sku})`);
        seenSignatures.add(signature);
        uniqueVariants.push(variant);
      });
      
      productSetInput.variants = uniqueVariants;
      log(`✅ Filtrado final: ${uniqueVariants.length} variantes únicas después del completado`);
    } else {
      log(`✅ No hay duplicados en productSetInput antes del envío`);
    }

    const rawResponse = await withRetry(() =>
      admin.graphql(PRODUCT_SET, {
        variables: {
          input: productSetInput
        }
      })
    );

    const responseData = await parseGraphQLResponse(rawResponse);

    const errors = responseData?.data?.productSet?.userErrors || [];
    if (errors.length) {
      log(`❌ Error estableciendo variantes:`, errors);
      return { success: false, error: errors };
    }

    const updatedProduct = responseData?.data?.productSet?.product || {};
    const createdVariants = updatedProduct.variants?.edges?.map(edge => edge.node) || [];
    
    if (CONFIG.LOG) {
      log(`✅ ${createdVariants.length} variantes establecidas exitosamente con SKUs`);
    }

    return { success: true, variants: createdVariants };
    
  } catch (error) {
    log(`💥 Error creando variantes: ${error.message}`);
    return { success: false, error: error.message };
  }
}

// =============================================================================
// PRODUCT CREATION (Original - for single products)
// =============================================================================

async function createShopifyProduct(admin, p) {
  // Validar y limpiar datos según especificaciones de Shopify API
  const title = sanitize(p.title) || "Producto sin título";
  const vendor = sanitize(p.vendor) || "Sin marca";
  const description = sanitize(p.description) || "";
  
  // Validar precio
  const price = parseFloat(p.price);
  if (isNaN(price) || price <= 0) {
    log(`❌ Precio inválido para ${title}: ${p.price}`);
    return { success: false, error: "Precio inválido" };
  }
  
  // CORREGIDO: ProductCreateInput siguiendo documentación oficial exacta
  const productInput = {
    title: title,
    vendor: vendor,
    descriptionHtml: description,
    status: "ACTIVE", // Enum válido: ACTIVE | ARCHIVED | DRAFT | UNLISTED
    productType: sanitize(p.category) || "", // Campo correcto
  };
  
  // Tags: debe ser array de strings
  const tagsArray = (p.tags || [])
    .filter(Boolean)
    .map(tag => sanitize(tag))
    .filter(tag => tag && tag.length > 0);
    
  if (tagsArray.length > 0) {
    productInput.tags = tagsArray;
  }
  
  if (CONFIG.LOG) {
    log(`🔧 ProductCreateInput válido para ${title}:`, JSON.stringify(productInput, null, 2));
  }
  
  try {
    // Paso 1: Crear producto básico con variables correctas
    const rawResponse = await withRetry(() =>
      admin.graphql(PRODUCT_CREATE, { 
        variables: { 
          product: productInput 
        } 
      })
    );

    // Parsear respuesta usando función auxiliar
    const responseData = await parseGraphQLResponse(rawResponse);

    const errors = responseData?.data?.productCreate?.userErrors || [];
    if (errors.length) {
      log(`❌ Error creando producto ${title}:`, errors);
      return { success: false, error: errors.map(e => e.message).join("; ") };
    }

    const createdProduct = responseData?.data?.productCreate?.product;
    if (!createdProduct || !createdProduct.id) {
      log(`❌ No se pudo crear el producto ${title}`);
      log(`🔍 responseData completo:`, JSON.stringify(responseData, null, 2));
      return { success: false, error: "No se pudo crear el producto" };
    }

    log(`✅ Producto base creado: ${createdProduct.title} (ID: ${createdProduct.id})`);

    // Paso 2: Agregar imágenes al producto
    const imagesResult = await addProductImages(admin, createdProduct.id, [p]);
    if (!imagesResult.success) {
      log(`⚠️ Error agregando imágenes: ${imagesResult.error}`);
    }

    // Paso 3: Actualizar la variante por defecto con nuestros datos
    if (createdProduct.variants?.edges?.length > 0) {
      const defaultVariant = createdProduct.variants.edges[0].node;
      await updateDefaultVariant(admin, defaultVariant.id, p, createdProduct.id);
    }

log(`🎉 Producto creado exitosamente: ${createdProduct.title} (ID: ${createdProduct.id})`);
  // Publicar el producto en los canales Online Store y Shop
  await publishProductToChannels(admin, createdProduct.id);
  return { success: true, product: createdProduct };
  } catch (error) {
    log(`💥 Excepción creando producto ${title}:`, error.message);
    return { success: false, error: error.message };
  }
}

// Función auxiliar para actualizar la variante por defecto
async function updateDefaultVariant(admin, variantId, p, productId = null) {
  try {
    // Generar SKU único (GTIN > MPN > g:id)
    const sku = p.gtin || p.mpn || p['g:id'];
    
    // Si no tenemos productId, lo extraemos del variantId
    let actualProductId = productId;
    if (!actualProductId && variantId) {
      // El variantId tiene formato: "gid://shopify/ProductVariant/123"
      // Necesitamos el productId, que podemos obtener consultando la variante
      const variantQuery = `
        query getVariant($id: ID!) {
          productVariant(id: $id) {
            product {
              id
            }
          }
        }
      `;
      
      const variantResponse = await admin.graphql(variantQuery, {
        variables: { id: variantId }
      });
      
      const variantData = await parseGraphQLResponse(variantResponse);
      actualProductId = variantData?.data?.productVariant?.product?.id;
      
      if (!actualProductId) {
        log(`❌ No se pudo obtener productId para variante ${variantId}`);
        return;
      }
    }
    
    // ✅ NUEVO: Actualizar las opciones del producto antes de actualizar la variante
    // Crear las opciones correctas basadas en los datos del producto
    const correctProductOptions = [];
    
    // Capacidad
    const capacityValue = normalizeCapacity(p.title);
    correctProductOptions.push({
      name: "Capacidad",
      values: [{ name: capacityValue }]
    });
    
    // Condición  
    const CONDITIONS_DISPLAY = {
      "new": "Nuevo",
      "refurbished": "Reacondicionado", 
      "used": "Usado"
    };
    const conditionValue = p.condition ? 
      (CONDITIONS_DISPLAY[p.condition] || p.condition) : 
      "Nuevo";
    correctProductOptions.push({
      name: "Condición", 
      values: [{ name: conditionValue }]
    });
    
    // Color si existe
    if (p.color) {
      correctProductOptions.push({
        name: "Color",
        values: [{ name: p.color }]
      });
    }
    
    log(`🔧 Actualizando opciones del producto a: [${correctProductOptions.map(o => o.name).join(', ')}]`);
    
    // Preparar la variante con los optionValues correctos para incluir en la actualización
    const variantForUpdate = {
      id: variantId,
      price: parseFloat(p.price).toString(),
      sku: sku ? sku.toString() : undefined,
      inventoryPolicy: "DENY",
      optionValues: [
        { optionName: "Capacidad", name: capacityValue },
        { optionName: "Condición", name: conditionValue }
      ]
    };
    
    // Agregar Color si existe
    if (p.color) {
      variantForUpdate.optionValues.push({ optionName: "Color", name: p.color });
    }
    
    // Actualizar el producto con las opciones correctas Y la variante
    const updateProductInput = {
      id: actualProductId,
      productOptions: correctProductOptions,
      variants: [variantForUpdate] // INCLUIR la variante es obligatorio
    };
    
    const updateProductResponse = await withRetry(() =>
      admin.graphql(PRODUCT_SET, {
        variables: { input: updateProductInput }
      })
    );
    
    const updateProductResult = await parseGraphQLResponse(updateProductResponse);
    if (updateProductResult.data?.productSet?.userErrors?.length > 0) {
      log(`❌ Error actualizando opciones del producto:`, updateProductResult.data.productSet.userErrors);
      return; // Salir si hay errores
    } else {
      log(`✅ Opciones del producto y variante actualizadas correctamente`);
    }
    
    // Ya se actualizó todo en una sola operación, no necesitamos más lógica
    return;
  } catch (error) {
    log(`❌ Error en updateDefaultVariant: ${error.message}`);
    throw error;
  }
}
// =============================================================================

async function updateShopifyProduct(admin, existing, p) {
  // Preparar datos del producto para productSet
  const productSetInput = {
    id: existing.id,
    title: p.title,
    vendor: p.vendor,
    descriptionHtml: p.description,
    status: p.status,
    tags: Array.from(
      new Set([...(existing.tags || "").split(", "), ...(p.tags || [])])
    ).join(", ")
  };

  // Actualizar variante por defecto si existe
  const variant = existing.variants?.edges?.[0]?.node;
  if (variant) {
    const variantInput = { id: variant.id };
    
    // Solo agregar campos que han cambiado
    if (p.price && p.price.toString() !== variant.price) {
      variantInput.price = p.price.toString();
    }
    if (p.sku && p.sku !== variant.sku) {
      variantInput.sku = p.sku.toString();
    }
    if (p.gtin && p.gtin !== variant.barcode) {
      variantInput.barcode = p.gtin.toString();
    }

    // Crear imagen si existe y obtener mediaId
    if (p.image_link) {
      try {
        new URL(p.image_link);
        
        // Crear media primero
        const mediaResponse = await withRetry(() =>
          admin.graphql(PRODUCT_CREATE_MEDIA, {
            variables: {
              productId: existing.id,
              media: [{
                originalSource: p.image_link,
                alt: `${p.title} - Imagen del producto`.slice(0, 120),
                mediaContentType: "IMAGE"
              }]
            }
          })
        );
        
        const mediaData = await parseGraphQLResponse(mediaResponse);
        const mediaErrors = mediaData?.data?.productCreateMedia?.mediaUserErrors || [];
        
        if (mediaErrors.length === 0) {
          const createdMedia = mediaData?.data?.productCreateMedia?.media?.[0];
          if (createdMedia?.id) {
            variantInput.mediaId = createdMedia.id;
          }
        } else {
          log(`❌ Error creando media:`, mediaErrors);
        }
      } catch (error) {
        log(`⚠️ URL de imagen inválida ignorada: ${p.image_link}`);
      }
    }

    // Solo incluir variantes si hay cambios
    if (Object.keys(variantInput).length > 1) {
      productSetInput.variants = [variantInput];
    }
  }

  // Log crítico antes de productSet
  log(`🔍 PRODUCTSET INPUT - updateShopifyProduct:`);
  log(`   Producto: ${productSetInput.id}`);
  if (productSetInput.variants) {
    log(`   Variantes: ${productSetInput.variants.length}`);
    productSetInput.variants.forEach((v, i) => {
      const fields = Object.keys(v).filter(k => k !== 'id');
      log(`   Variant ${i+1}: ${fields.join(', ')}`);
    });
  } else {
    log(`   Sin variantes`);
  }

  const rawResponse = await withRetry(() =>
    admin.graphql(PRODUCT_SET, { 
      variables: { input: productSetInput }
    })
  );

  const responseData = await parseGraphQLResponse(rawResponse);
  
  const errs = responseData?.data?.productSet?.userErrors || [];
  if (errs.length) {
    log(`❌ Error actualizando producto con productSet:`, errs);
    return { success: false };
  }

  return { success: true };
}

function cleanProductTitleDynamic(title, variants) {
  if (!title) return "Producto sin título";
  // Extraer colores únicos de las variantes
  const colorSet = new Set();
  variants.forEach(v => {
    if (v.color && typeof v.color === 'string') {
      colorSet.add(v.color.trim());
    }
  });
  let clean = title;
  // Eliminar cada color encontrado del título
  colorSet.forEach(color => {
    if (color.length > 0) {
      // Elimina el color como palabra completa, insensible a mayúsculas
      const regex = new RegExp(`\\b${color}\\b`, 'gi');
      clean = clean.replace(regex, '');
    }
  });
  // Elimina patrones de capacidad (ej: 128GB, 512GB, 1TB, etc)
  clean = clean.replace(/\b\d+(GB|TB|ML|L)\b/gi, "");
  // Elimina dobles espacios y recorta
  return clean.replace(/\s+/g, " ").trim();
}

// =============================================================================
// PROCESSING FUNCTIONS - SINGLE GROUP
// =============================================================================

/**
 * Procesa un solo grupo de variantes
 * @param {Object} admin - Cliente admin de Shopify
 * @param {string} groupId - ID del grupo
 * @param {Array} variants - Lista de variantes del grupo
 * @param {Map} cache - Cache para evitar búsquedas duplicadas
 * @param {string} shop - Dominio de la tienda para eventos
 * @param {Object} globalStats - Estadísticas globales compartidas
 * @returns {Object} - Resultado del procesamiento
 */
async function processVariantGroup(admin, groupId, variants, cache, shop, globalStats) {
  try {
    const isVariantGroup = variants.length > 1;
    const masterProduct = isVariantGroup ? selectMasterProduct(variants) : variants[0];
    
    // Enviar evento de procesamiento actual
    if (shop) {
      log(`[SSE] Enviando evento 'processing' con precio:`, masterProduct.price);
      log(`[SSE] masterProduct:`, {
        type: "processing",
        productTitle: masterProduct.title,
        productSku: masterProduct.sku,
        barcode: masterProduct.gtin,
        price: masterProduct.price,
        vendor: masterProduct.vendor,
        brand: masterProduct.brand,
        tags: masterProduct.tags,
        condition: masterProduct.condition,
        availability: masterProduct.availability,
        color: masterProduct.color,
        productId: masterProduct.id,
        imageUrl: masterProduct.image_link || (variants[0] && variants[0].image_link) || null,
        processed: globalStats.processed,
        total: globalStats.total,
        action: "processing"
      });
      await sendProgressEvent(shop, {
        type: "processing",
        productTitle: masterProduct.title,
        productSku: masterProduct.sku,
        barcode: masterProduct.gtin,
        price: masterProduct.price,
        vendor: masterProduct.vendor,
        brand: masterProduct.brand,
        tags: masterProduct.tags,
        condition: masterProduct.condition,
        availability: masterProduct.availability,
        color: masterProduct.color,
        productId: masterProduct.id,
        imageUrl: masterProduct.image_link || (variants[0] && variants[0].image_link) || null,
        processed: globalStats.processed,
        total: globalStats.total,
        action: "processing"
      });
    }
    
    // Buscar si el producto ya existe usando item_group_id
    const firstVariantSku = variants[0].sku;
    const existing = await findExistingProductByGroup(admin, groupId, firstVariantSku);
    
    let result;
    if (existing) {
      log(`🔍 Producto existente encontrado para el grupo ${groupId} (ID: ${existing.id})`);
      // Actualizar producto existente con nuevas variantes
      const sendProgressFn = shop ? (type, message) => sendProgressEvent(shop, { type, message }) : null;
      result = await updateExistingProduct(admin, existing, variants, sendProgressFn);
    
      log('El resultado de la actualización es:', result);
      if (result) {
        // Enviar evento de actualización con datos reales del producto procesado
        if (shop && result.product) {
          const p = result.product;
          const mainVariant = p.variants?.edges?.[0]?.node || {};

          log(`[SSE] Enviando evento 'updated' para producto:`, {
            type: "updated",
            productTitle: p.title || masterProduct.title,
            productSku: mainVariant.sku || masterProduct.sku,
            barcode: mainVariant.barcode || masterProduct.gtin,
            price: (mainVariant.price !== undefined && mainVariant.price !== null)
              ? parseFloat(mainVariant.price).toFixed(2)
              : (masterProduct.price !== undefined && masterProduct.price !== null)
                ? parseFloat(masterProduct.price).toFixed(2)
                : "N/A",
            vendor: p.vendor || masterProduct.vendor,
            brand: p.brand || masterProduct.brand,
            tags: p.tags || masterProduct.tags,
            condition: mainVariant.condition || masterProduct.condition,
            availability: p.availability || masterProduct.availability,
            color: mainVariant.color || masterProduct.color,
            productId: p.id || existing.id,
            imageUrl: p.imageUrl || masterProduct.image_link || (variants[0] && variants[0].image_link) || null,
            processed: globalStats.processed + 1,
            total: globalStats.total,
            variants: Array.isArray(p.variants) ? p.variants.length : variants.length,
            variantsUpdated: result.variantsUpdated || 0,
            variantsCreated: result.variantsCreated || 0,
            action: "updated"
          });

          // Si no hay variantes, price = masterProduct.price; si hay variantes, price = null y se envía variantDetails
          const eventPriceUpd = (!isVariantGroup)
            ? (masterProduct.price !== undefined && masterProduct.price !== null ? parseFloat(masterProduct.price).toFixed(2) : "N/A")
            : null;
          await sendProgressEvent(shop, {
            type: "updated",
            productTitle: p.title || masterProduct.title,
            productSku: mainVariant.sku || masterProduct.sku,
            barcode: mainVariant.barcode || masterProduct.gtin,
            price: eventPriceUpd,
            vendor: p.vendor || masterProduct.vendor,
            brand: p.brand || masterProduct.brand,
            tags: p.tags || masterProduct.tags,
            condition: mainVariant.condition || masterProduct.condition,
            availability: p.availability || masterProduct.availability,
            color: mainVariant.color || masterProduct.color,
            productId: p.id || existing.id,
            imageUrl: p.imageUrl || masterProduct.image_link || (variants[0] && variants[0].image_link) || null,
            processed: globalStats.processed + 1,
            total: globalStats.total,
            variants: Array.isArray(p.variants) ? p.variants.length : variants.length,
            variantsUpdated: result.variantsUpdated || 0,
            variantsCreated: result.variantsCreated || 0,
            action: "updated",
            variantDetails: variants.map(v => ({ title: v.title, price: v.price, color: v.color }))
          });
        }
        
        // Actualizar estadísticas
        globalStats.updated++;
        globalStats.variantsUpdated += result.variantsUpdated || 0;
        globalStats.variantsCreated += result.variantsCreated || 0;
        
        return { 
          success: true, 
          action: 'updated', 
          variants: variants.length,
          variantsUpdated: result.variantsUpdated || 0,
          variantsCreated: result.variantsCreated || 0
        };
      }
    } else {
      log(`➕ No se encontró producto existente para el grupo ${groupId}. Creando nuevo producto.`);
      // Crear nuevo producto
      if (isVariantGroup) {
        // Crear producto con múltiples variantes
        result = await createShopifyProductWithVariants(admin, variants);
        if (result.success && result.product) {
          // Enviar evento de creación con variantes usando datos reales
          const p = result.product;
          const mainVariant = p.variants?.edges?.[0]?.node || {};
          if (shop) {

            log(`[SSE] Enviando evento 'created' para producto con variantes:`, {
              type: "created",
              productTitle: p.title || masterProduct.title,
              productSku: mainVariant.sku || masterProduct.sku,
              barcode: mainVariant.barcode || masterProduct.gtin,
              price: (mainVariant.price !== undefined && mainVariant.price !== null)
                ? parseFloat(mainVariant.price).toFixed(2)
                : (masterProduct.price !== undefined && masterProduct.price !== null)
                  ? parseFloat(masterProduct.price).toFixed(2)
                  : "N/A",
              vendor: p.vendor || masterProduct.vendor,
              brand: p.brand || masterProduct.brand,
              tags: p.tags || masterProduct.tags,
              condition: mainVariant.condition || masterProduct.condition,
              availability: p.availability || masterProduct.availability,
              color: mainVariant.color || masterProduct.color,
              productId: p.id,
              imageUrl: p.imageUrl || masterProduct.image_link || (variants[0] && variants[0].image_link) || null,
              processed: globalStats.processed + 1,
              total: globalStats.total,
              variants: Array.isArray(p.variants) ? p.variants.length : variants.length,
              variantDetails: variants.map(v => ({ title: v.title, price: v.price, color: v.color }))
            });
            // Si hay variantes, price = null y se envía variantDetails
            await sendProgressEvent(shop, {
              type: "created",
              productTitle: p.title || masterProduct.title,
              productSku: mainVariant.sku || masterProduct.sku,
              barcode: mainVariant.barcode || masterProduct.gtin,
              price: null,
              vendor: p.vendor || masterProduct.vendor,
              brand: p.brand || masterProduct.brand,
              tags: p.tags || masterProduct.tags,
              condition: mainVariant.condition || masterProduct.condition,
              availability: p.availability || masterProduct.availability,
              color: mainVariant.color || masterProduct.color,
              productId: p.id,
              imageUrl: p.imageUrl || masterProduct.image_link || (variants[0] && variants[0].image_link) || null,
              processed: globalStats.processed + 1,
              total: globalStats.total,
              variants: Array.isArray(p.variants) ? p.variants.length : variants.length,
              variantDetails: variants.map(v => ({ title: v.title, price: v.price, color: v.color }))
            });
          }
          // Actualizar estadísticas
          globalStats.created++;
          globalStats.variantsCreated += variants.length;
          return { success: true, action: 'created', variants: variants.length };
        }
      } else {
        log(`➕ No se encontró producto existente para el grupo ${groupId}. Creando nuevo producto.`);
        // Crear producto simple
        result = await createShopifyProduct(admin, masterProduct);
        if (result.success && result.product) {
          // Enviar evento de creación simple usando datos reales
          const p = result.product;
          const mainVariant = p.variants?.edges?.[0]?.node || {};
          if (shop) {
            log(`[SSE] Enviando evento 'created' para producto simple:`, {
              type: "created",
              productTitle: p.title || masterProduct.title,
              productSku: mainVariant.sku || masterProduct.sku,
              barcode: mainVariant.barcode || masterProduct.gtin,
              price: (mainVariant.price !== undefined && mainVariant.price !== null)
                ? parseFloat(mainVariant.price).toFixed(2)
                : (masterProduct.price !== undefined && masterProduct.price !== null)
                  ? parseFloat(masterProduct.price).toFixed(2)
                  : "N/A",
              vendor: p.vendor || masterProduct.vendor,
              brand: p.brand || masterProduct.brand,
              tags: p.tags || masterProduct.tags,
              condition: mainVariant.condition || masterProduct.condition,
              availability: p.availability || masterProduct.availability,
              color: mainVariant.color || masterProduct.color,
              productId: p.id,
              imageUrl: p.imageUrl || masterProduct.image_link || null,
              processed: globalStats.processed + 1,
              total: globalStats.total,
              variants: Array.isArray(p.variants) ? p.variants.length : 1
            });
            await sendProgressEvent(shop, {
              type: "created",
              productTitle: p.title || masterProduct.title,
              productSku: mainVariant.sku || masterProduct.sku,
              barcode: mainVariant.barcode || masterProduct.gtin,
              price: (mainVariant.price !== undefined && mainVariant.price !== null)
                ? parseFloat(mainVariant.price).toFixed(2)
                : (masterProduct.price !== undefined && masterProduct.price !== null)
                  ? parseFloat(masterProduct.price).toFixed(2)
                  : "N/A",
              vendor: p.vendor || masterProduct.vendor,
              brand: p.brand || masterProduct.brand,
              tags: p.tags || masterProduct.tags,
              condition: mainVariant.condition || masterProduct.condition,
              availability: p.availability || masterProduct.availability,
              color: mainVariant.color || masterProduct.color,
              productId: p.id,
              imageUrl: p.imageUrl || masterProduct.image_link || null,
              processed: globalStats.processed + 1,
              total: globalStats.total,
              variants: Array.isArray(p.variants) ? p.variants.length : 1
            });
          }
          // Actualizar estadísticas
          globalStats.created++;
          globalStats.variantsCreated += 1;
          return { success: true, action: 'created', variants: 1 };
        }
      }
    }
    // Si llegamos aquí, algo falló
    if (!result.success) {
      // Enviar evento de error
      if (shop) {
        await sendProgressEvent(shop, {
          type: "error",
          productTitle: masterProduct.title,
          processed: globalStats.processed + 1,
          total: globalStats.total,
          error: result.error,
          variants: isVariantGroup ? variants.length : 1
        });
      }
      return { success: false, error: result.error };
    }
  } catch (err) {
    log(`❌ Error procesando grupo ${groupId}: ${err.message}`);
    // Enviar evento de error de excepción
    if (shop) {
      await sendProgressEvent(shop, {
        type: "error",
        productTitle: "Error de procesamiento",
        processed: globalStats.processed + 1,
        total: globalStats.total,
        error: err.message
      });
    }
    return { success: false, error: err.message };
  }
}

// =============================================================================
// MAIN PROCESSOR WITH VARIANTS SUPPORT (ORIGINAL)
// =============================================================================
export async function processProductsWithDuplicateCheck(admin, products, shop) {
  const stats = {
    created: 0,
    updated: 0,
    errors: 0,
    processed: 0,
    variants: 0,
    totalProducts: products.length,
    productsProcessed: 0,
    productsCreated: 0,
    productsUpdated: 0,
    productsOmitted: 0,
    productsWithErrors: 0
  };

  log(`Los productos son: ${products}`)
  const cache = new Map();
  // Paso 1: Agrupar productos por variantes
  const variantGroups = groupProductsByVariants(products);
  if (CONFIG.LOG) {
    log(`🚀 Procesando ${variantGroups.size} grupos de productos`);
  }
  // Enviar evento de inicio de sincronización
  if (shop) {
    await sendProgressEvent(shop, {
      type: "sync_started",
      message: "Iniciando sincronización de productos",
      totalItems: variantGroups.size,
      startTime: new Date().toISOString()
    });
  }
  for (const [groupId, variants] of variantGroups) {
    try {
      // Determinar si es un grupo de variantes o producto único
      const isVariantGroup = variants.length > 1;
      const masterProduct = isVariantGroup ? selectMasterProduct(variants) : variants[0];
      if (CONFIG.LOG && isVariantGroup) {
        log(`🔄 Procesando grupo de variantes ${groupId}: ${variants.length} variantes`);
      }
      // Enviar evento de procesamiento actual
      if (shop) {
        await sendProgressEvent(shop, {
          type: "processing",
          productTitle: masterProduct.title,
          processed: stats.processed,
          total: variantGroups.size,
          variants: isVariantGroup ? variants.length : 1,
          currentStep: isVariantGroup ? `Procesando variantes (${variants.length})` : "Procesando producto",
          totalProducts: stats.totalProducts,
          productsProcessed: stats.productsProcessed,
          productsCreated: stats.productsCreated,
          productsUpdated: stats.productsUpdated,
          productsOmitted: stats.productsOmitted,
          productsWithErrors: stats.productsWithErrors
        });
      }
      // Buscar si el producto ya existe (usar producto maestro para búsqueda)
      const existing = await findExistingProduct(admin, masterProduct, cache);
      let result;
      if (existing) {
        // Actualizar producto existente (por ahora solo el principal)
        result = await updateShopifyProduct(admin, existing, masterProduct);
        if (result.success) {
          stats.updated++;
          stats.productsUpdated++;
          stats.productsProcessed++;
          // Enviar evento de actualización
          if (shop) {
            const eventPriceUpd = (!isVariantGroup)
              ? (masterProduct.price !== undefined && masterProduct.price !== null ? parseFloat(masterProduct.price).toFixed(2) : "N/A")
              : null;
            await sendProgressEvent(shop, {
              type: "updated",
              productTitle: masterProduct.title,
              productSku: masterProduct.sku,
              barcode: masterProduct.gtin,
              price: eventPriceUpd,
              vendor: masterProduct.vendor,
              brand: masterProduct.brand,
              tags: masterProduct.tags,
              condition: masterProduct.condition,
              availability: masterProduct.availability,
              color: masterProduct.color,
              productId: existing.id,
              imageUrl: masterProduct.image_link || (variants[0] && variants[0].image_link) || null,
              processed: stats.processed + 1,
              total: variantGroups.size,
              variants: isVariantGroup ? variants.length : 1,
              variantDetails: isVariantGroup ? variants.map(v => ({ title: v.title, price: v.price, color: v.color })) : undefined,
              totalProducts: stats.totalProducts,
              productsProcessed: stats.productsProcessed,
              productsCreated: stats.productsCreated,
              productsUpdated: stats.productsUpdated,
              productsOmitted: stats.productsOmitted,
              productsWithErrors: stats.productsWithErrors
            });
          }
        }
      } else {
        // Crear nuevo producto
        if (isVariantGroup) {
          // Crear producto con múltiples variantes
          result = await createShopifyProductWithVariants(admin, variants);
          if (result.success) {
            stats.created++;
            stats.variants += variants.length;
            stats.productsCreated++;
            stats.productsProcessed++;
            // Enviar evento de creación con variantes
            if (shop) {
              await sendProgressEvent(shop, {
                type: "created",
                productTitle: masterProduct.title,
                productSku: masterProduct.sku,
                barcode: masterProduct.gtin,
                price: null,
                vendor: masterProduct.vendor,
                brand: masterProduct.brand,
                tags: masterProduct.tags,
                condition: masterProduct.condition,
                availability: masterProduct.availability,
                color: masterProduct.color,
                productId: result.product?.id,
                imageUrl: masterProduct.image_link || (variants[0] && variants[0].image_link) || null,
                processed: stats.processed + 1,
                total: variantGroups.size,
                variants: variants.length,
                variantDetails: variants.map(v => ({ title: v.title, price: v.price, color: v.color })),
                totalProducts: stats.totalProducts,
                productsProcessed: stats.productsProcessed,
                productsCreated: stats.productsCreated,
                productsUpdated: stats.productsUpdated,
                productsOmitted: stats.productsOmitted,
                productsWithErrors: stats.productsWithErrors
              });
            }
          }
        } else {
          // Crear producto simple
          result = await createShopifyProduct(admin, masterProduct);
          if (result.success) {
            stats.created++;
            stats.productsCreated++;
            stats.productsProcessed++;
            // Enviar evento de creación simple
            if (shop) {
              const eventPrice = (masterProduct.price !== undefined && masterProduct.price !== null ? parseFloat(masterProduct.price).toFixed(2) : "N/A");
              await sendProgressEvent(shop, {
                type: "created",
                productTitle: masterProduct.title,
                productSku: masterProduct.sku,
                barcode: masterProduct.gtin,
                price: eventPrice,
                vendor: masterProduct.vendor,
                brand: masterProduct.brand,
                tags: masterProduct.tags,
                condition: masterProduct.condition,
                availability: masterProduct.availability,
                color: masterProduct.color,
                productId: result.product?.id,
                imageUrl: masterProduct.image_link || null,
                processed: stats.processed + 1,
                total: variantGroups.size,
                variants: 1,
                totalProducts: stats.totalProducts,
                productsProcessed: stats.productsProcessed,
                productsCreated: stats.productsCreated,
                productsUpdated: stats.productsUpdated,
                productsOmitted: stats.productsOmitted,
                productsWithErrors: stats.productsWithErrors
              });
            }
          }
        }
      }
      if (!result.success) {
        stats.errors++;
        stats.productsWithErrors++;
        stats.productsProcessed++;
        if (CONFIG.LOG) {
          log(`❌ Error procesando grupo ${groupId}: ${result.error}`);
        }
        // Enviar evento de error
        if (shop) {
          await sendProgressEvent(shop, {
            type: "error",
            productTitle: masterProduct.title,
            processed: stats.processed + 1,
            total: variantGroups.size,
            error: result.error,
            variants: isVariantGroup ? variants.length : 1,
            totalProducts: stats.totalProducts,
            productsProcessed: stats.productsProcessed,
            productsCreated: stats.productsCreated,
            productsUpdated: stats.productsUpdated,
            productsOmitted: stats.productsOmitted,
            productsWithErrors: stats.productsWithErrors
          });
        }
      }
      stats.processed++;
      await sleep(CONFIG.RATE_LIMIT_DELAY);
    } catch (err) {
      stats.errors++;
      stats.productsWithErrors++;
      stats.productsProcessed++;
      log(`❌ Error procesando grupo ${groupId}: ${err.message}`);
      // Enviar evento de error de excepción
      if (shop) {
        await sendProgressEvent(shop, {
          type: "error",
          productTitle: "Error de procesamiento",
          processed: stats.processed + 1,
          total: variantGroups.size,
          error: err.message,
          totalProducts: stats.totalProducts,
          productsProcessed: stats.productsProcessed,
          productsCreated: stats.productsCreated,
          productsUpdated: stats.productsUpdated,
          productsOmitted: stats.productsOmitted,
          productsWithErrors: stats.productsWithErrors
        });
      }
    }
  }
  // Estadísticas finales
  const finalStats = {
    ...stats,
    totalVariantGroups: variantGroups.size,
    totalProducts: stats.totalProducts,
    productsProcessed: stats.productsProcessed,
    productsCreated: stats.productsCreated,
    productsUpdated: stats.productsUpdated,
    productsOmitted: stats.productsOmitted,
    productsWithErrors: stats.productsWithErrors
  };
  // Enviar evento de finalización
  if (shop) {
    await sendProgressEvent(shop, {
      type: "sync_completed",
      message: "Sincronización completada",
      stats: finalStats,
      totalProducts: stats.totalProducts,
      productsProcessed: stats.productsProcessed,
      productsCreated: stats.productsCreated,
      productsUpdated: stats.productsUpdated,
      productsOmitted: stats.productsOmitted,
      productsWithErrors: stats.productsWithErrors,
      endTime: new Date().toISOString()
    });
  }
  log("✅ Sincronización finalizada:", finalStats);
  return finalStats;
}

// =============================================================================
// OPTIMIZED PARALLEL PROCESSOR
// =============================================================================
export async function processProductsParallel(admin, products, shop) {
  const stats = { created: 0, updated: 0, errors: 0, processed: 0, variants: 0 };
  const cache = new Map();
  // Paso 1: Agrupar productos por variantes
  const variantGroups = groupProductsByVariants(products);
  const groupEntries = Array.from(variantGroups.entries());
  if (CONFIG.LOG) {
    log(`🚀 [PARALLEL] Procesando ${variantGroups.size} grupos con lotes de ${CONFIG.PARALLEL_BATCH_SIZE}`);
  }
  // Enviar evento de inicio de sincronización
  if (shop) {
    await sendProgressEvent(shop, {
      type: "sync_started",
      message: `Iniciando sincronización paralela (lotes de ${CONFIG.PARALLEL_BATCH_SIZE})`,
      totalItems: variantGroups.size,
      startTime: new Date().toISOString()
    });
  }
  // Estadísticas globales compartidas para eventos
  const globalStats = { 
    processed: 0, 
    total: variantGroups.size,
    created: 0,
    updated: 0,
    variantsCreated: 0,
    variantsUpdated: 0,
    errors: 0
  };
  // Procesar en lotes paralelos
  for (let i = 0; i < groupEntries.length; i += CONFIG.PARALLEL_BATCH_SIZE) {
    const batch = groupEntries.slice(i, i + CONFIG.PARALLEL_BATCH_SIZE);
    if (CONFIG.LOG) {
      log(`📦 [PARALLEL] Procesando lote ${Math.floor(i / CONFIG.PARALLEL_BATCH_SIZE) + 1}/${Math.ceil(groupEntries.length / CONFIG.PARALLEL_BATCH_SIZE)} (${batch.length} grupos)`);
    }
    // Procesar el lote en paralelo
    const batchPromises = batch.map(async ([groupId, variants]) => {
      return processVariantGroup(admin, groupId, variants, cache, shop, globalStats);
    });
    try {
      const batchResults = await Promise.allSettled(batchPromises);
      // Procesar resultados del lote
      for (let j = 0; j < batchResults.length; j++) {
        const result = batchResults[j];
        const [groupId, variants] = batch[j];
        globalStats.processed += variants.length;
        stats.processed += variants.length;
        if (result.status === 'fulfilled' && result.value.success) {
          const action = result.value.action;
          if (action === 'created') {
            stats.created++;
            stats.variants += result.value.variants;
          } else if (action === 'updated') {
            stats.updated++;
          }
        } else {
          stats.errors++;
          const error = result.status === 'rejected' ? result.reason?.message : result.value?.error;
          if (CONFIG.LOG) {
            log(`❌ [PARALLEL] Error en grupo ${groupId}: ${error}`);
          }
        }
      }
      // Pequeña pausa entre lotes para evitar sobrecarga
      if (i + CONFIG.PARALLEL_BATCH_SIZE < groupEntries.length) {
        await sleep(CONFIG.RATE_LIMIT_DELAY + 200); // Delay adicional de 200ms
      }
    } catch (batchError) {
      log(`❌ [PARALLEL] Error procesando lote: ${batchError.message}`);
      stats.errors += batch.length;
    }
  }
  // Estadísticas finales combinando datos de stats y globalStats
  const finalStats = {
    created: globalStats.created || 0,
    updated: globalStats.updated || 0,
    errors: globalStats.errors || stats.errors || 0,
    processed: globalStats.processed || stats.processed || 0,
    variants: globalStats.variantsCreated + globalStats.variantsUpdated || stats.variants || 0,
    variantsCreated: globalStats.variantsCreated || 0,
    variantsUpdated: globalStats.variantsUpdated || 0,
    totalVariantGroups: variantGroups.size,
    totalProducts: products.length,
    processingMode: 'parallel',
    batchSize: CONFIG.PARALLEL_BATCH_SIZE
  };
  // Enviar evento de finalización
  if (shop) {
    await sendProgressEvent(shop, {
      type: "sync_completed",
      message: `Sincronización paralela completada (lotes de ${CONFIG.PARALLEL_BATCH_SIZE})`,
      stats: finalStats,
      endTime: new Date().toISOString()
    });
  }
  log("✅ [PARALLEL] Sincronización finalizada:", finalStats);
  return finalStats;
}

// =============================================================================
// XML FROM URL → PARSE + OPTIONAL SYNC
// =============================================================================
export async function parseXMLData(xmlUrl, admin, shop) {
  log(`🌐 Descargando XML: ${xmlUrl}`);
  const res = await fetch(xmlUrl);
  if (!res.ok) throw new Error(`XML error: ${res.status}`);
  const xml = await res.text();
  const parser = new XMLParser({ ignoreAttributes: false });
  const parsed = parser.parse(xml);
  const items = parsed?.rss?.channel?.item || [];
  if (!items.length) {
    log("⚠️ XML vacío");
    return [];
  }
  const products = items.map(parseXmlProduct);
  log(`📦 Productos parseados: ${products.length}`);
  // Mostrar estadísticas de variantes
  const variantGroups = groupProductsByVariants(products);
  const variantStats = {
    totalProducts: products.length,
    variantGroups: variantGroups.size,
    singleProducts: [...variantGroups.values()].filter(group => group.length === 1).length,
    multiVariantGroups: [...variantGroups.values()].filter(group => group.length > 1).length,
  };
  log(`📊 Estadísticas de variantes:`, variantStats);
  if (!admin) return products;
  return await processProductsParallel(admin, products, shop);
}

/**
 * @deprecated Use parseXMLData instead - this function doesn't support variants or images
 * Mantener solo para compatibilidad con código legacy
 */
export async function parseXMLOnly(xmlUrl) {
  log(`🌐 parseXMLOnly: ${xmlUrl}`);
  const res = await fetch(xmlUrl);
  const xml = await res.text();
  const parser = new XMLParser({ ignoreAttributes: false });
  const parsed = parser.parse(xml);
  const items = parsed?.rss?.channel?.item || [];
  return items.map(parseXmlProduct);
}

export default { parseXMLData, processProductsWithDuplicateCheck, processProductsParallel };
