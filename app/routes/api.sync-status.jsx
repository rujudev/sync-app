import { authenticate } from "../shopify.server.js";

// Endpoint para consultar el estado/resultado final de la sincronización
export const loader = async ({ request }) => {
  try {
    const { session } = await authenticate.admin(request);
    const shopDomain = session.shop.replace('.myshopify.com', '');
    
    // Obtener resultado final si existe
    const lastResult = global.lastSyncResult;
    
    if (!lastResult || lastResult.shopDomain !== shopDomain) {
      return Response.json({
        success: false,
        message: 'No hay resultados de sincronización disponibles',
        shopDomain
      });
    }
    
    return Response.json({
      success: true,
      result: lastResult
    });
    
  } catch (error) {
    console.error('❌ Error consultando estado de sync:', error);
    return Response.json(
      { 
        success: false, 
        error: error.message 
      }, 
      { status: 500 }
    );
  }
};