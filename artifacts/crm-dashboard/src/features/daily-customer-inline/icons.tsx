/** Armita v1.1 timeline / phone / copy icons (from daily-customer-inline index.html). */
export function DciSprites() {
  return (
    <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true" focusable="false">
      <symbol id="dci-i-phone" viewBox="0 0 24 24"><path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2" /></symbol>
      <symbol id="dci-i-copy" viewBox="0 0 24 24"><rect x="8" y="8" width="12" height="12" rx="2.5" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></symbol>
      <symbol id="dci-i-plus" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" /></symbol>
      <symbol id="dci-i-today" viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="17" rx="3" /><path d="M8 2.5v3M16 2.5v3M8 11l2 2 4-4M8 17h8" /></symbol>
      <symbol id="dci-i-bell" viewBox="0 0 24 24"><path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15zM10 20.5a2.2 2.2 0 0 0 4 0" /></symbol>
    </svg>
  );
}
export function DciIcon({ id, className = "" }: { id: string; className?: string }) {
  const href = id.startsWith("i-") ? `#dci-${id}` : `#dci-i-${id}`;
  return <svg className={`i ${className}`.trim()} aria-hidden="true"><use href={href} /></svg>;
}
