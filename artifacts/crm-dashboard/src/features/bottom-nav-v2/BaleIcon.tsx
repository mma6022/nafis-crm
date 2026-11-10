/** i-bale from Armita bottom-nav-v2 v1.0 — a chat bubble with three dots, distinct from the assistant i-bot. */
export function BaleIcon({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 6h13a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3h-5l-4 3.2V18H7a3 3 0 0 1-3-3V9a3 3 0 0 1 3-3z" />
      <circle cx="9" cy="12" r="1.15" fill="currentColor" stroke="none" />
      <circle cx="13" cy="12" r="1.15" fill="currentColor" stroke="none" />
      <circle cx="17" cy="12" r="1.15" fill="currentColor" stroke="none" />
    </svg>
  );
}
