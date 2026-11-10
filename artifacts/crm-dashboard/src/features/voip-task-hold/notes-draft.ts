/** File / customer / task draft for the notes composer (spec §۳). Not cleared on form open, hang-up, or cancel. */
export function vthDraftKey(fileId: number | null | undefined, customerId: number | null | undefined, task?: string | null) {
  return `vth-draft:${fileId ?? 0}:${customerId ?? 0}:${task || 'file'}`;
}
export function vthDraftRead(key: string): string {
  try { return sessionStorage.getItem(key) ?? ''; } catch { return ''; }
}
export function vthDraftWrite(key: string, value: string) {
  try { sessionStorage.setItem(key, value); } catch { /* private mode */ }
}
export function vthDraftClear(key: string) {
  try { sessionStorage.removeItem(key); } catch { /* ignore */ }
}
