import { attachSendProgress } from "../services/xml-sync.server";

export const loader = async ({ request }) => {
  const url = new URL(request.url);
  const sessionId = url.searchParams.get("sessionId");

  const stream = new ReadableStream({
    start(controller) {
      // Escribimos un helper para enviar eventos
      const send = (type, data) => {
        controller.enqueue(
          `event: ${type}\n` +
          `data: ${JSON.stringify(data)}\n\n`
        );
      };

      const interval = setInterval(() => {
        send("ping", { t: Date.now() });
      }, 20000); // 20s recomendado (Cloudflare idle timeout ≈ 100s)

      // Registrar limpiador si el cliente cierra la conexión
      controller.signal?.addEventListener("abort", () => {
        clearInterval(interval);
        console.log("🔌 SSE abortada → limpiado heartbeat");
      });

      // Registramos la función para que xml-sync.server.js la use
      attachSendProgress((event) => {
        const evtType = event.type || event.step || "log";
        send(evtType, event);
      });

      // Evento inicial para confirmar conexión viva
      send("connected", { ok: true, sessionId });

      // La conexión queda abierta
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
    },
  });
};
