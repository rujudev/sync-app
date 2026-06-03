// config.js
// Configuración global, logging, retry y cliente GraphQL de Shopify.
// Todos los módulos que necesiten llamar a la API de Shopify importan de aquí.

export const CONFIG = { LOG: true, RETRIES: 3, RETRY_BASE_DELAY_MS: 200 };

export const log = (...args) => CONFIG.LOG && console.log(new Date().toISOString(), ...args);

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
  try {
    return await withRetry(() => admin.graphql(query, { variables }));
  } catch (e) {
    if (e.response) {
      const text = await e.response.text();
      console.error("❌ adminGraphql error response text:", text);
      throw new Error(`GraphQL request failed: ${e?.message || String(e)} — Response: ${text}`);
    }
  }
}
