// media-utils.js
// Utilidades para subir, esperar y hacer matching de imágenes en Shopify,
// y para validar dimensiones de imágenes del feed.

import { adminGraphql, log } from './config.js';
import { GET_PRODUCT_MEDIA } from '../shopify/queries';

// Extrae el nombre base de una URL de imagen sin extensión.
export function extractBaseName(url) {
  const file = url.split("/").pop();
  return file.split(".")[0];
}

// ── CAMBIO 8 ── Matching robusto entre URL original del XML y URL de
// preview de Shopify. Shopify puede transformar el nombre del fichero:
//   - convertir a minúsculas
//   - añadir sufijos (_grande, _medium, tamaño, etc.)
//   - reemplazar + por _ u otros caracteres
// La estrategia anterior (includes exacto) fallaba en estos casos,
// dejando imageMap incompleto y variantes sin mediaId.
// Ahora normalizamos ambas cadenas a minúsculas y comparamos el baseName
// del XML contra el segmento de fichero de la URL de Shopify, ignorando
// sufijos añadidos y extensión.
export function buildImageMapByMatching(productObj, uploadedNodes) {
  const map = {};

  for (const img of productObj.images) {
    const original = img.originalSrc;
    const baseNorm = extractBaseName(original)
      .replace(/\+/g, '_')
      .toLowerCase();

    const found = uploadedNodes.find(node => {
      const previewUrl = node?.preview?.image?.url;
      if (!previewUrl) return false;
      const shopifyFile = previewUrl.split('/').pop().split('?')[0].toLowerCase();
      const shopifyBase = shopifyFile.replace(/\.[^.]+$/, '').replace(/_\d{10,}$/, '');
      return shopifyBase.includes(baseNorm) || baseNorm.includes(shopifyBase);
    });

    if (found) {
      map[original] = found.id;
    } else {
      log(`⚠️ [ImageMap] No se encontró media en Shopify para: ${baseNorm}`);
    }
  }

  return map;
}

// ── CAMBIO 6 ── Esperar a que TODAS las imágenes esperadas tengan URL,
// no solo alguna. Shopify procesa imágenes de forma asíncrona: devolver
// en cuanto urls.length > 0 significa que el imageMap se construye
// incompleto si aún hay imágenes pendientes de procesar, dejando
// variantes sin mediaId aunque la imagen exista en el producto.
// Con expectedCount esperamos a que el número de URLs listas coincida
// con el número de imágenes que acabamos de subir.
export async function getProductMediaWithRetry(admin, productId, maxRetries = 10, delayMs = 2000, expectedCount = 0) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const res = await adminGraphql(admin, GET_PRODUCT_MEDIA, { id: productId });
    const data = await res.json();
    const mediaNodes = data?.data?.product?.media?.nodes || [];
    const urls = mediaNodes.map(m => m.preview?.image?.url).filter(Boolean);

    const target = expectedCount > 0 ? expectedCount : 1;
    if (urls.length >= target) {
      return mediaNodes;
    }

    log(`⏳ [Media] Intento ${attempt}/${maxRetries} — ${urls.length}/${target} imágenes listas para producto ${productId}`);
    await new Promise(r => setTimeout(r, delayMs));
  }
  log(`⚠️ [Media] Timeout esperando imágenes para producto ${productId}. Continuando con las disponibles.`);
  return [];
}

// Obtiene las dimensiones de una imagen remota.
export async function getImageDimensions(imageUrl) {
  try {
    const res = await fetch(imageUrl);
    const arrayBuffer = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const { imageSize } = await import('image-size');
    return imageSize(buffer);
  } catch (err) {
    log("⚠️ Error getting image dimensions:", err);
    return null;
  }
}

// Determina si una imagen es demasiado pequeña para el catálogo.
export function isImageSmall(dimensions) {
  if (!dimensions) return false;
  const { width, height } = dimensions;
  return width < 600 || height < 600;
}
