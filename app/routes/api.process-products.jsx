import { processProductsParallel } from "../services/xml-sync.server.js"; // ⚡ VERSIÓN PARALELA OPTIMIZADA
import { authenticate } from "../shopify.server.js";

export const action = async ({ request }) => {
  console.error('🚀 [PROCESS-API] Endpoint de procesamiento llamado');
  
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  try {
    const { admin } = await authenticate.admin(request);
    console.error('✅ [PROCESS-API] Autenticación exitosa');
    
    const body = await request.json();
    const { products, shopDomain } = body;
    
    if (!products || !Array.isArray(products) || products.length === 0) {
      return Response.json({ error: "No hay productos para procesar" }, { status: 400 });
    }

    if (!shopDomain) {
      return Response.json({ error: "Shop domain requerido" }, { status: 400 });
    }

    console.error(`📦 [PROCESS-API] Iniciando procesamiento de ${products.length} productos para shop: ${shopDomain}`);
    
    // ⚡ OPTIMIZACIÓN: Procesamiento inmediato con versión optimizada
    (async () => {
      try {
        console.error('⚡ [PROCESS-API] Iniciando procesamiento PARALELO...');
        await processProductsParallel(admin, products, shopDomain);
        console.error('🎉 [PROCESS-API] Procesamiento PARALELO completado');
      } catch (error) {
        console.error('❌ [PROCESS-API] Error en procesamiento optimizado:', error);
      }
    })(); // ← Fire-and-forget optimizado
    
    // Respuesta inmediata
    return Response.json({
      success: true,
      message: '⚡ Procesamiento PARALELO iniciado en background (lotes de 6)',
      totalProducts: products.length,
      shopDomain,
      startedAt: new Date().toISOString()
    });

  } catch (error) {
    console.error('❌ [PROCESS-API] Error:', error);
    return Response.json({ 
      error: error.message || "Error iniciando procesamiento",
      success: false 
    }, { status: 500 });
  }
};