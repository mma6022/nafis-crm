/** FILE-DETAIL v1.1: per-user flag (flag.file_detail_v1.user.N; missing = OFF) + the resend-signature-link calls + Persian date helpers. */
import { useQuery } from '@tanstack/react-query';

const FD = '۰۱۲۳۴۵۶۷۸۹';
export const fd = (v: string | number) => String(v).replace(/[0-9]/g, (d) => FD[Number(d)]);
/** Amounts: Persian digits with «٬» as the thousands mark. */
export const faAmount = (v: string | number | null | undefined) => {
  const s = String(v ?? '').replace(/[^\d]/g, '');
  return s ? fd(s.replace(/^0+(?=\d)/, '').replace(/\B(?=(\d{3})+(?!\d))/g, '٬')) : '';
};

export function useFileDetailV1Flag(enabled = true): boolean {
  const q = useQuery({
    queryKey: ['file-detail-v1', 'me'],
    enabled,
    staleTime: 60_000,
    retry: false,
    queryFn: async () => {
      const r = await fetch('/api/file-detail-v1/me', { credentials: 'include' });
      if (!r.ok) return { on: false };
      const b = await r.json().catch(() => null);
      return { on: b?.on === true };
    },
  });
  return q.data?.on === true;
}

export type ResendItem = {
  generationId: number; purpose: string; contractNumber: string | null; providerStatus: string | null;
  createdAt: string | null; firstSentAt: string | null; lastSentAt: string | null; retryAfterSeconds: number;
};
export type ResendState = { available: boolean; items: ResendItem[] };

export function useLinkResends(appId: number, enabled: boolean) {
  return useQuery({
    queryKey: ['file-detail-v1', 'link-resends', appId],
    enabled,
    retry: false,
    refetchOnWindowFocus: true,
    queryFn: async (): Promise<ResendState & { at: number }> => {
      const r = await fetch(`/api/file-detail-v1/files/${appId}/link-resends`, { credentials: 'include' });
      if (!r.ok) return { available: false, items: [], at: Date.now() };
      const b = await r.json();
      return { available: b?.available === true, items: Array.isArray(b?.items) ? b.items : [], at: Date.now() };
    },
  });
}

export type ResendOutcome =
  | { kind: 'ok'; sentAt: string }
  | { kind: 'wait'; seconds: number }
  | { kind: 'turn'; fileId: number | null; name: string | null }
  | { kind: 'error' };

/** One press = one request; the server enforces 1 per contract per 10 minutes and returns the seconds left. */
export async function resendSignatureLink(appId: number, generationId: number): Promise<ResendOutcome> {
  let r: Response;
  try {
    r = await fetch(`/api/loan-applications/${appId}/contract-generations/${generationId}/resend-link`, {
      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
  } catch { return { kind: 'error' }; }
  const b = await r.json().catch(() => ({}));
  if (r.ok) return { kind: 'ok', sentAt: typeof b?.sentAt === 'string' ? b.sentAt : new Date().toISOString() };
  if (r.status === 429) {
    const s = Number(b?.retryAfterSeconds ?? r.headers.get('Retry-After'));
    return { kind: 'wait', seconds: Number.isFinite(s) && s > 0 ? s : 600 };
  }
  if (b?.error === 'board_turn') {
    const id = Number(b?.details?.turnFileId);
    const nm = b?.details?.turnFileName;
    return { kind: 'turn', fileId: Number.isFinite(id) && id > 0 ? id : null, name: typeof nm === 'string' && nm.trim() ? nm.trim() : null };
  }
  return { kind: 'error' };
}

/** «۸ دقیقه‌ی دیگر»; under a minute in seconds rounded up to 5. */
export const leftText = (sec: number) => sec >= 60 ? `${fd(Math.ceil(sec / 60))} دقیقه‌ی دیگر` : `${fd(Math.min(55, Math.ceil(sec / 5) * 5))} ثانیه‌ی دیگر`;

const TZ = 'Asia/Tehran';
const dayFmt = new Intl.DateTimeFormat('fa-IR-u-ca-persian', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' });
const dayYFmt = new Intl.DateTimeFormat('fa-IR-u-ca-persian', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const keyFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const hmFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const valid = (iso?: string | null) => !!iso && !Number.isNaN(Date.parse(iso));
const clean = (s: string) => s.replace(/،/g, '').replace(/\s+/g, ' ').trim();
export const dayKey = (iso: string) => keyFmt.format(new Date(iso));
export const hm = (iso?: string | null) => valid(iso) ? fd(hmFmt.format(new Date(iso!)).replace(/^0(\d)/, '$1')) : '';
export const longDate = (iso?: string | null) => valid(iso) ? clean(dayYFmt.format(new Date(iso!))) : '';
export const shortDay = (iso?: string | null) => valid(iso) ? clean(dayFmt.format(new Date(iso!))) : '';
function rel(iso: string, now = Date.now()): 'today' | 'yesterday' | null {
  const k = dayKey(iso);
  if (k === dayKey(new Date(now).toISOString())) return 'today';
  if (k === dayKey(new Date(now - 86_400_000).toISOString())) return 'yesterday';
  return null;
}
/** Day separator: «امروز، پنجشنبه ۷ آبان». */
export const dayLabel = (iso: string) => { const r = rel(iso); const d = shortDay(iso); return r === 'today' ? `امروز، ${d}` : r === 'yesterday' ? `دیروز، ${d}` : d; };
/** «همین الان» / «امروز ۱۱:۲۰» / «دیروز ۹:۰۵» / «دوشنبه ۴ آبان». */
export const whenShort = (iso?: string | null) => {
  if (!valid(iso)) return '';
  if (Date.now() - Date.parse(iso!) < 60_000) return 'همین الان';
  const r = rel(iso!);
  return r === 'today' ? `امروز ${hm(iso)}` : r === 'yesterday' ? `دیروز ${hm(iso)}` : shortDay(iso);
};
export const sizeFa = (n: number) => n >= 1048576 ? `${fd((Math.round(n / 104857.6) / 10).toString()).replace('.', '٫')} مگابایت` : `${fd(Math.max(1, Math.ceil(n / 1024)))} کیلوبایت`;
