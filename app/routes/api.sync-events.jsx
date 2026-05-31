import { attachSendProgress } from "../services/xml-sync.server.js";

export const loader = async ({ request }) => {
  const url = new URL(request.url);
  const sessionId = url.searchParams.get("sessionId");

  const stream = new ReadableStream({
    start(controller) {
      const send = (type, data) => {
        try {
          controller.enqueue(
            `event: ${type}\n` +
            `data: ${JSON.stringify(data)}\n\n`
          );
        } catch(e) {
          console.warn("Stream cerrado al intentar escribir");
        }
      };

      const interval = setInterval(() => {
        // Tu ping original modificado como evento estándar para no romper nada
        send("ping", { t: Date.now() });
      }, 20000);

      // Registramos tu función y guardamos el limpiador que nos devuelve
      const detach = attachSendProgress((event) => {
        const evtType = event.type || event.step || "log";
        send(evtType, event);
      });

      // Registrar limpiador si el cliente cierra la conexión
      controller.signal?.addEventListener("abort", () => {
        clearInterval(interval);
        detach(); // 🌟 Esto remueve de forma segura esta conexión muerta del Set
        console.log("🔌 SSE abortada → limpiado heartbeat y progreso");
      });

      send("connected", { ok: true, sessionId });
    },
    cancel() {
      console.log("🔌 SSE cerrada por el cliente");
    }
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no", // 🌟 Evita que Fly.io acumule eventos en caché
    },
  });
};