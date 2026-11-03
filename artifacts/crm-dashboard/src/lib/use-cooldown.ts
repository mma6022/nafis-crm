import { useCallback, useEffect, useState } from 'react';

/** SAPI-NOCREDIT: after any verify error the CRM verify button stays disabled for `ms` (default 60s). */
export const VERIFY_COOLDOWN_MS = 60_000;
export function useCooldown(ms = VERIFY_COOLDOWN_MS) {
  const [until, setUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (until <= Date.now()) return;
    const t = window.setInterval(() => { const n = Date.now(); setNow(n); if (n >= until) window.clearInterval(t); }, 1000);
    return () => window.clearInterval(t);
  }, [until]);
  const start = useCallback(() => { const n = Date.now(); setNow(n); setUntil(n + ms); }, [ms]);
  const left = Math.max(0, Math.ceil((until - now) / 1000));
  return { active: left > 0, left, start };
}
export const cooldownLabel = (left: number) => `تلاش دوباره تا ${left.toLocaleString('fa-IR')} ثانیه دیگر`;
