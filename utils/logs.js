export const CONFIG = { LOG: true, RETRIES: 3, RETRY_BASE_DELAY_MS: 200 };

// Log base con timestamp limpio (solo hora, minutos y segundos para ahorrar espacio)
export const log = (...args) => {
  if (!CONFIG.LOG) return;
  const time = new Date().toLocaleTimeString('es-ES', { hour12: false });
  console.log(`[${time}]`, ...args);
};

// Formateador eficiente para agrupar la info de productos y variantes en una sola línea
export const logProduct = (action, brand, model, groupId, totalVariants) => {
  if (!CONFIG.LOG) return;
  const time = new Date().toLocaleTimeString('es-ES', { hour12: false });
  const icon = action === 'CREATE' ? '🆕 [CREAR]' : '🔄 [ACTUALIZAR]';
  console.log(`[${time}] ${icon} ${brand.padEnd(10)} | ${model.padEnd(25)} | ID: ${groupId.padEnd(15)} | Variantes: ${totalVariants}`);
};