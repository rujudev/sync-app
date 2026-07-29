// gemini-client.js
// Única puerta de salida hacia la API de Gemini. Ningún otro módulo debe
// hablar directamente con Google.
//
// Contrato: callJson NUNCA lanza. Devuelve el objeto parseado o null.
// Todo el sistema de IA está diseñado para degradar solo: si esto devuelve
// null, el pipeline cae al extractor determinista y la sync termina igual.
//
// Módulo exclusivamente de servidor: solo se importa desde el grafo de
// xml-sync.server.js. La API key jamás debe acabar en un bundle de cliente.

import { GoogleGenAI } from '@google/genai';
import { logger, sleep } from '../config.js';

// Verifica el ID del modelo en la documentación de Google antes de desplegar.
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

// Espaciado mínimo entre llamadas. El límite del plan gratuito se mide en
// peticiones por minuto, así que serializamos y separamos. 4,5 s ≈ 13 rpm.
const MIN_INTERVAL_MS = Number(process.env.GEMINI_MIN_INTERVAL_MS || 4500);

const MAX_RETRIES = 3;
const TIMEOUT_MS = 60000;

// ── Cliente perezoso ────────────────────────────────────────────────────────
// Se instancia en la primera llamada, no al importar el módulo: así importar
// este archivo sin GEMINI_API_KEY definida no revienta el arranque de la app.
let client = null;

function getClient() {
  if (!client) {
    client = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY,
      httpOptions: { timeout: TIMEOUT_MS },
    });
  }
  return client;
}

// ── Cola serializada ────────────────────────────────────────────────────────
// Todas las llamadas pasan por aquí en orden, con separación garantizada.
// La cola nunca se rompe: un fallo en una llamada no bloquea las siguientes.
let queue = Promise.resolve();
let lastCallAt = 0;

function enqueue(fn) {
  const run = queue.then(async () => {
    const wait = MIN_INTERVAL_MS - (Date.now() - lastCallAt);
    if (wait > 0) await sleep(wait);
    try {
      return await fn();
    } finally {
      lastCallAt = Date.now();
    }
  });
  queue = run.then(() => {}, () => {});
  return run;
}

export function isEnabled() {
  return Boolean(process.env.GEMINI_API_KEY);
}

// El SDK lanza ApiError con .status en los errores HTTP. En fallos de red
// puede no haberlo, así que se busca también en el mensaje.
function statusOf(err) {
  const direct = err?.status ?? err?.code ?? err?.response?.status;
  if (typeof direct === 'number') return direct;
  const m = String(err?.message || '').match(/\b(4\d{2}|5\d{2})\b/);
  return m ? Number(m[1]) : null;
}

function isRetriable(err) {
  const status = statusOf(err);
  if (status === 429) return true;
  if (status && status >= 500 && status < 600) return true;
  // Timeouts y caídas de red transitorias
  const name = String(err?.name || '');
  if (name === 'TimeoutError' || name === 'AbortError') return true;
  return /timeout|fetch failed|network|ECONNRESET|ETIMEDOUT/i.test(String(err?.message || ''));
}

async function requestOnce(prompt, responseSchema, systemInstruction) {
  const response = await getClient().models.generateContent({
    model: MODEL,
    contents: prompt,
    config: {
      // temperature 0: misma entrada → misma salida, en la medida en que el
      // modelo lo permite. Imprescindible para que el caché tenga sentido.
      temperature: 0,
      responseMimeType: 'application/json',
      ...(responseSchema ? { responseSchema } : {}),
      ...(systemInstruction ? { systemInstruction } : {}),
    },
  });

  // Prompt bloqueado por filtros de seguridad
  const blockReason = response?.promptFeedback?.blockReason;
  if (blockReason) throw new Error(`prompt bloqueado: ${blockReason}`);

  // Salida truncada: el JSON quedaría incompleto y el parse fallaría igual,
  // pero así el log dice la causa real.
  const finishReason = response?.candidates?.[0]?.finishReason;
  if (finishReason === 'MAX_TOKENS') {
    throw new Error('respuesta truncada (MAX_TOKENS) — reduce el tamaño del lote');
  }

  // En @google/genai, .text es una propiedad, no una función.
  const text = response?.text;
  if (!text || !String(text).trim()) {
    throw new Error(`respuesta vacía (finishReason: ${finishReason || 'desconocido'})`);
  }

  return JSON.parse(text);
}

// Devuelve el objeto parseado o null. No lanza nunca.
export async function callJson(prompt, responseSchema = null, { systemInstruction = null, label = 'ia' } = {}) {
  if (!isEnabled()) {
    logger.warn(`⚠️ [IA/${label}] GEMINI_API_KEY no definida — se omite la llamada.`);
    return null;
  }

  return enqueue(async () => {
    let attempt = 0;
    while (true) {
      try {
        return await requestOnce(prompt, responseSchema, systemInstruction);
      } catch (err) {
        attempt++;

        if (!isRetriable(err) || attempt > MAX_RETRIES) {
          logger.error(`❌ [IA/${label}] ${err?.message || err}`);
          return null;
        }

        const delay = 2000 * Math.pow(2, attempt - 1);
        logger.warn(`⚠️ [IA/${label}] reintento ${attempt}/${MAX_RETRIES} en ${delay}ms — ${err?.message || err}`);
        await sleep(delay);
      }
    }
  });
}
