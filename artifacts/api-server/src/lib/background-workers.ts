/** Set CRM_DISABLE_BACKGROUND_WORKERS=1 for side-port benches and maintenance boots. */
export function backgroundWorkersDisabled(): boolean {
  return process.env.CRM_DISABLE_BACKGROUND_WORKERS === "1";
}
