// api.sync-cancel.js
// Endpoint para cancelar la importación en curso

let isCancelled = false;

export function loader() {
  isCancelled = true;
  return Response.json({ success: true, cancelled: true });
}

export function wasCancelled() {
  return isCancelled;
}

export function resetCancelFlag() {
  isCancelled = false;
}
