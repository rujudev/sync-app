// config.js
// Configuración global, logging, retry y cliente GraphQL de Shopify.
// Todos los módulos que necesiten llamar a la API de Shopify importan de aquí.

export const CONFIG = { LOG: true, RETRIES: 3, RETRY_BASE_DELAY_MS: 200 };

export const log = (...args) => CONFIG.LOG && console.log(new Date().toISOString(), ...args);

// ── Logger con color ANSI ─────────────────────────────────────────────────────
// Cada método añade un color distinto para facilitar el escaneo visual del
// terminal. Los códigos ANSI son soportados por la mayoría de terminales Node.
const C = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  red:    '\x1b[31m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  cyan:   '\x1b[36m',
  gray:   '\x1b[90m',
};

const stamp = () => new Date().toISOString();

export const logger = {
  // Separador visual entre productos/grupos — cyan bold con línea de ═
  section: (title) => {
    if (!CONFIG.LOG) return;
    const line = '═'.repeat(60);
    console.log(`\n${C.bold}${C.cyan}${line}${C.reset}`);
    console.log(`${C.bold}${C.cyan}  ${stamp()}  ${title}${C.reset}`);
    console.log(`${C.bold}${C.cyan}${line}${C.reset}\n`);
  },
  success: (...a) => CONFIG.LOG && console.log(`${stamp()} ${C.green}`, ...a, C.reset),
  warn:    (...a) => CONFIG.LOG && console.log(`${stamp()} ${C.yellow}`, ...a, C.reset),
  error:   (...a) => CONFIG.LOG && console.log(`${stamp()} ${C.red}`, ...a, C.reset),
  info:    (...a) => CONFIG.LOG && console.log(`${stamp()} ${C.cyan}`, ...a, C.reset),
  skip:    (...a) => CONFIG.LOG && console.log(`${stamp()} ${C.gray}`, ...a, C.reset),
  // Detalles secundarios: dim + sangría con ›
  detail:  (...a) => CONFIG.LOG && console.log(`${stamp()} ${C.dim}   ›`, ...a, C.reset),
};

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function withRetry(fn, retries = CONFIG.RETRIES, baseDelay = CONFIG.RETRY_BASE_DELAY_MS) {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      attempt++;
      const isThrottled = err?.message?.toLowerCase().includes("throttle") || err?.status === 429;
      if (attempt > retries) throw err;
      const delay = baseDelay * Math.pow(2, attempt - 1) * (isThrottled ? 2 : 1);
      log(`⚠️ GraphQL retry ${attempt}/${retries} after ${delay}ms — ${err?.message || err}`);
      await sleep(delay);
    }
  }
}

export async function adminGraphql(admin, query, variables = {}) {
  // ── CORRECCIÓN "Body has already been read" ──────────────────────────────
  // Problema original: cuando withRetry agotaba los reintentos y relanzaba el
  // error, el catch de aquí intentaba leer e.response.text(). Pero el SDK de
  // Shopify reutiliza el mismo objeto Response entre reintentos; una vez que
  // el body se consume en el primer intento (internamente por el SDK), los
  // siguientes intentos de .text() lanzan "Body is unusable: Body has already
  // been read", enmascarando el error original.
  //
  // Solución: leer el texto del body solo si es la primera y única llamada
  // (sin reintentos), extrayendo la lectura fuera de withRetry. Si withRetry
  // ya agotó sus reintentos el body puede estar consumido, así que se captura
  // ese segundo error y se relanza el original con su mensaje.
  try {
    return await withRetry(() => admin.graphql(query, { variables }));
  } catch (e) {
    if (e.response) {
      try {
        const text = await e.response.text();
        console.error("❌ adminGraphql error response text:", text);
        throw new Error(`GraphQL request failed: ${e?.message || String(e)} — Response: ${text}`);
      } catch (readErr) {
        // El body ya fue consumido en un reintento anterior; relanzar el error
        // original con su mensaje para no perder la causa raíz.
        if (readErr.message?.includes("Body")) {
          throw new Error(`GraphQL request failed: ${e?.message || String(e)}`);
        }
        throw readErr;
      }
    }
    throw e;
  }
}