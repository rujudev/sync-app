import { authenticate } from "../shopify.server.js";

// ✨ Mapa global { shop → writer simulado }
const connections = new Map();

export const loader = async ({ request }) => {
  try {
    console.log('🔍 SSE endpoint called with URL:', request.url);
    
    const url = new URL(request.url);
    const sessionId = url.searchParams.get('sessionId');
    
    let shopDomain;
    
    if (sessionId) {
      console.log('🔑 Using sessionId from URL parameter:', sessionId);
      
      // Extraer shop del sessionId (formato: offline_shop.myshopify.com)
      shopDomain = sessionId
        .replace('offline_', '')
        .replace('.myshopify.com', '');
      console.log('✅ Extracted shop from sessionId:', shopDomain);
    } else {
      console.log('🔍 Using traditional authentication');
      try {
        const authResult = await authenticate.admin(request);
        const session = authResult.session;
        shopDomain = session.shop.replace('.myshopify.com', '');
        console.log('✅ Authentication successful for SSE');
      } catch (authError) {
        console.error('❌ Authentication failed in SSE endpoint:', authError);
        return new Response(`Authentication failed: ${authError.message}`, { 
          status: 401,
          headers: { 'Content-Type': 'text/plain' }
        });
      }
    }

    if (!shopDomain) {
      return new Response('Missing sessionId', { status: 400 });
    }

    console.log(`🔗 SSE connection opened for shop: ${shopDomain}`);
    console.log(`🔍 Active connections before: ${connections.size}`);

    const encoder = new TextEncoder();

    // ✨ ReadableStream que el navegador consumirá
    const stream = new ReadableStream({
      start(controller) {
        // ✨ Writer simulado que escribe directamente en el socket
        const writer = {
          write: (chunk) => {
            controller.enqueue(chunk);
            return Promise.resolve();
          },
          close: () => {
            controller.close();
            return Promise.resolve();
          },
          ready: Promise.resolve(undefined),
          stream: { state: 'writable' },
          desiredSize: 1
        };

        connections.set(shopDomain, {
          writer,
          shop: shopDomain,
          connectedAt: new Date()
        });

        // ✨ Envío inicial + flush real
        const send = (ev, data) =>
          writer.write(encoder.encode(`event:${ev}\ndata:${JSON.stringify(data)}\n\n`));

        send("connected", { 
          shop: shopDomain,
          timestamp: new Date().toISOString()
        });
        writer.write(encoder.encode(":\n\n")); // ← flush instantáneo
        
        console.log(`✅ SSE connection established for ${shopDomain}`);
      },

      cancel() {
        console.log(`🔌 ReadableStream cancelled for ${shopDomain}`);
        connections.delete(shopDomain);
      },
    });
    
    console.log(`✅ SSE connection established for ${shopDomain}`);

    // Devolver el stream como Response SSE
    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Cache-Control'
      }
    });
    
  } catch (error) {
    console.error('❌ Error in SSE endpoint:', error);
    return new Response('SSE error', { status: 500 });
  }
};

// ✨ Función sendProgressEvent optimizada para entrega inmediata
export const sendProgressEvent = async (shop, eventData) => {
  console.log(`🔍 [SSE-DEBUG] Attempting to send ${eventData.type} to shop: ${shop}`);
  
  const connection = connections.get(shop);
  if (!connection || !connection.writer) {
    console.log(`⚠️ [SSE-DEBUG] No connection found for shop: ${shop}. Active connections: ${connections.size}`);
    console.log(`🔍 [SSE-DEBUG] Available shops: ${Array.from(connections.keys()).join(', ')}`);
    // return false;
  }

  try {
    const encoder = new TextEncoder();
    const payload = `event:${eventData.type}\ndata:${JSON.stringify(eventData)}\n\n`;

    console.log(`📤 [SSE-DEBUG] Sending payload to ${shop}: ${payload.substring(0, 100)}...`);
    
    // Escribir evento
    await connection.writer.write(encoder.encode(payload));
    
    // Flush MÚLTIPLE para forzar entrega inmediata (anti-buffering)
    await connection.writer.write(encoder.encode(": keepalive\n\n"));
    await connection.writer.write(encoder.encode(": flush\n\n"));
    
    console.log(`📡 [SSE-SUCCESS] Event ${eventData.type} sent successfully to ${shop}`);
    // return true;
  } catch (error) {
    console.error(`❌ [SSE-ERROR] Failed to send to ${shop}:`, error.message);
    console.error(`🔍 [SSE-ERROR] Connection state:`, {
      hasConnection: !!connection,
      hasWriter: !!connection?.writer,
      writerState: connection?.writer?.stream?.state
    });
    
    // Limpiar conexión rota
    connections.delete(shop);
    // return false;
  }
};

// ✨ Cierre directo con writer simulado
export async function closeConnection(shop) {
  const connection = connections.get(shop);
  if (connection?.writer) {
    try {
      await connection.writer.close();
      console.log(`✅ Connection closed for ${shop}`);
    } catch (error) {
      console.error(`❌ Error closing SSE writer for ${shop}:`, error);
    }
    connections.delete(shop);
  }
}

// Función de diagnóstico para verificar conexiones activas
export function getActiveConnections() {
  const activeConnections = Array.from(connections.entries()).map(([shop, conn]) => ({
    shop,
    connectedAt: conn.connectedAt,
    hasWriter: !!conn.writer
  }));
  
  console.log('🔍 Active SSE connections:', activeConnections);
  return activeConnections;
}