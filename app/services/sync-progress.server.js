import prisma from "../db.server.js";

// Servicio para manejo de progreso de sincronización
// Helper para obtener el dominio de la tienda desde el request
function getShopDomain(request) {
  // Extraer el shop desde los headers o la URL
  const url = new URL(request.url);
  const shop = url.searchParams.get('shop') || 
               request.headers.get('x-shopify-shop-domain') ||
               'unknown';
  return shop.replace('.myshopify.com', '');
}

// Inicializar progreso de sincronización
export async function initSyncProgress(shop, totalItems = 0) {
  try {
    const progress = await prisma.syncProgress.upsert({
      where: { shop },
      update: {
        status: 'parsing',
        currentStep: 'Inicializando sincronización...',
        totalItems,
        processedItems: 0,
        successItems: 0,
        errorItems: 0,
        currentProduct: null,
        errorMessage: null,
        startedAt: new Date(),
        completedAt: null
      },
      create: {
        shop,
        status: 'parsing',
        currentStep: 'Inicializando sincronización...',
        totalItems,
        processedItems: 0,
        successItems: 0,
        errorItems: 0
      }
    });
    
    return progress;
  } catch (error) {
    console.error('Error inicializando progreso:', error);
    throw error;
  }
}

// Actualizar progreso
export async function updateSyncProgress(shop, updates) {
  try {
    const progress = await prisma.syncProgress.update({
      where: { shop },
      data: {
        ...updates,
        updatedAt: new Date()
      }
    });
    
    return progress;
  } catch (error) {
    console.error('Error actualizando progreso:', error);
    // Si no existe, lo creamos
    if (error.code === 'P2025') {
      return await initSyncProgress(shop);
    }
    throw error;
  }
}

// Obtener progreso actual
export async function getSyncProgress(shop) {
  try {
    console.log('🔍 getSyncProgress - shop:', shop);
    
    if (!shop) {
      console.error('❌ getSyncProgress - shop is undefined or empty');
      return null;
    }
    
    const progress = await prisma.syncProgress.findUnique({
      where: { shop }
    });
    
    console.log('📊 getSyncProgress - result:', progress);
    
    return progress;
  } catch (error) {
    console.error('❌ Error obteniendo progreso:', error);
    return null;
  }
}

// Completar sincronización
export async function completeSyncProgress(shop, success = true, errorMessage = null) {
  try {
    const progress = await prisma.syncProgress.update({
      where: { shop },
      data: {
        status: success ? 'completed' : 'error',
        currentStep: success ? 'Sincronización completada' : 'Error en sincronización',
        errorMessage,
        completedAt: new Date()
      }
    });
    
    return progress;
  } catch (error) {
    console.error('Error completando progreso:', error);
    throw error;
  }
}

// Limpiar progreso antiguo (opcional)
export async function cleanOldProgress(hoursOld = 24) {
  try {
    const cutoff = new Date();
    cutoff.setHours(cutoff.getHours() - hoursOld);
    
    const result = await prisma.syncProgress.deleteMany({
      where: {
        OR: [
          {
            status: 'completed',
            completedAt: {
              lt: cutoff
            }
          },
          {
            status: 'error',
            updatedAt: {
              lt: cutoff
            }
          }
        ]
      }
    });
    
    console.log(`Limpiado ${result.count} registros de progreso antiguos`);
    return result;
  } catch (error) {
    console.error('Error limpiando progreso antiguo:', error);
  }
}

// Helper para extraer shop desde request
export function extractShopFromRequest(request) {
  return getShopDomain(request);
}