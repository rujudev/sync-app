// progress.js
// Sistema de eventos SSE (Server-Sent Events) para notificar el progreso
// de la sincronización a los clientes conectados.
// Separado del resto para poder importarlo desde cualquier ruta sin
// arrastrar toda la lógica de sync.

import { EventEmitter } from "events";

if (!globalThis.__syncEmitter) {
  globalThis.__syncEmitter = new EventEmitter();
  globalThis.__syncEmitter.setMaxListeners(50);
}

const _sendProgressConnections = new Set();

// Registra una función de envío SSE y devuelve un cleanup para cuando
// la conexión del cliente se cierre.
export function attachSendProgress(fn) {
  _sendProgressConnections.add(fn);
  return () => {
    _sendProgressConnections.delete(fn);
  };
}

// Emite un evento a todas las conexiones SSE activas.
export function sendProgress(event) {
  _sendProgressConnections.forEach((sendFn) => {
    try {
      sendFn(event);
    } catch (e) {
      console.warn("sendProgress failed para una conexión", e);
    }
  });
}
