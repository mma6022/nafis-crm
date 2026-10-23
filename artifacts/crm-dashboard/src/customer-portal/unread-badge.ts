const faDigits = (s: string) => s.replace(/\d/g, d => '۰۱۲۳۴۵۶۷۸۹'[Number(d)]);

/** Unread badge text for the «گفتگو» tab/nav: Persian digits, capped at «۹۹+»; null hides the badge. */
export function unreadBadge(count: unknown, onChat = false): string | null {
  const n = typeof count === 'number' && Number.isFinite(count) ? Math.floor(count) : 0;
  if (onChat || n <= 0) return null; // opening the chat clears it right away; the server read marker keeps it cleared
  return n > 99 ? `${faDigits('99')}+` : faDigits(String(n));
}

