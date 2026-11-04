/** «موارد اجباری خلاصه‌ی تماس» (design v1.2, Armita). Server returns 404 cs_off while flag.call_summary_fields_v1 is OFF → nothing renders. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ctReq, fa } from '@/features/call-transcripts/api';

export const csReq = ctReq;
export type CsKey = 'creditRank' | 'gRank' | 'planType' | 'docs' | 'sso' | 'arrears' | 'bounced';
export const CS_KEYS: CsKey[] = ['creditRank', 'gRank', 'planType', 'docs', 'sso', 'arrears', 'bounced'];
export const CS_LABEL: Record<CsKey, string> = { creditRank: 'رتبه‌ی متقاضی', gRank: 'رتبه‌ی ضامن', planType: 'نوع طرح', docs: 'مدارک', sso: 'بازنشسته‌ی تأمین اجتماعی', arrears: 'معوقه', bounced: 'چک برگشتی' };
export const CS_DOCS = ['national_card', 'birth_cert', 'payslip', 'retirement_decree', 'salary_deduction_cert', 'sayadi_or_promissory'] as const;
export type CsDoc = (typeof CS_DOCS)[number];
export const DOC_LABEL: Record<CsDoc, string> = { national_card: 'کارت ملی', birth_cert: 'شناسنامه', payslip: 'فیش حقوقی', retirement_decree: 'حکم یا گواهی بازنشستگی', salary_deduction_cert: 'گواهی کسر از حقوق', sayadi_or_promissory: 'چک صیادی یا سفته' };
export type CsState = 'a' | 'c' | 'u' | 'm' | 'e' | 'x' | 'n';
export type CsItem = { key: CsKey; label: string; state: CsState; value: unknown; text: string | null; atSec: number | null; reason: string | null; source: string | null };
export type CsProposal = { id: number; key: CsKey; fileValue: unknown; newValue: unknown; status: 'pending' | 'applied' | 'rejected'; decidedBy: string | null; decidedAt: string | null };
export type CsCall = { eventId: number; customerId: number | null; customerName?: string | null; kind: 'first' | 'later' | 'none'; items: CsItem[]; proposals: CsProposal[]; count: number; total: number;
  pendingCount?: number; canEdit: boolean; canDecide: boolean; required: boolean; formSavedAt: string | null; qualificationId?: number | null; extraction: 'none' | 'processing' | 'done' | 'failed'; sim: boolean; textState?: string };
export type CsHist = { value: unknown; at: string | null; source: string; sourceKey: string; eventId: number | null; by: string | null };
export type CsFile = { customerId: number; hasFile: boolean; items: { key: CsKey; label: string; value: unknown; meta: CsHist | null; history: CsHist[] }[]; count: number; total: number; pendingCount: number; pendingEventId: number | null; canEdit: boolean };
export type CsPrefill = { eventId: number | null; items: { key: CsKey; state: CsState; value: unknown; text: string | null; atSec: number | null; reason: string | null }[] };
export type CsReport = { from: string; to: string; totals: { calls: number; withEmpty: number; empty: number }; experts: { userId: number; name: string; calls: number; withEmpty: number; empty: number; top: { key: CsKey; label: string; n: number } | null }[] };
export type CsDetail = { expert: { userId: number; name: string }; withEmpty: number; empty: number; rows: { qualificationId: number; customerId: number; customerName: string | null; at: string; eventId: number | null; missing: { key: CsKey; label: string }[] }[]; more: number; page: number };

export const useCsConfig = (enabled = true) => useQuery<{ enabled: boolean; report?: boolean }>({ queryKey: ['cs-fields', 'config'], enabled, staleTime: 60_000, retry: false,
  queryFn: () => csReq<{ enabled: boolean; report?: boolean }>('GET', '/call-summary-fields/config').catch(() => ({ enabled: false })) });
export const useCsCall = (eventId: number | null | undefined, enabled: boolean) => useQuery<CsCall>({ queryKey: ['cs-fields', 'call', eventId], enabled: enabled && Boolean(eventId), retry: false,
  queryFn: () => csReq<CsCall>('GET', `/call-summary-fields/calls/${eventId}`),
  refetchInterval: (q) => (q.state.data?.extraction === 'processing' ? 8000 : false) });
export const useCsFile = (customerId: number | null | undefined, enabled: boolean) => useQuery<CsFile>({ queryKey: ['cs-fields', 'file', customerId], enabled: enabled && Boolean(customerId), retry: false,
  queryFn: () => csReq<CsFile>('GET', `/call-summary-fields/customers/${customerId}/items`) });
export const fetchCsPrefill = (customerId: number) => csReq<CsPrefill>('GET', `/call-summary-fields/customers/${customerId}/prefill`);

/** One mutation hook for every call-view action; the server answers with the fresh call items. */
export function useCsCallAct(eventId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: { t: 'set'; key: CsKey; body: { value: unknown } | { noAnswer: true; reason: string } } | { t: 'confirm' } | { t: 'apply' | 'reject'; id: number } | { t: 'all' }) =>
      a.t === 'set' ? csReq<CsCall>('PUT', `/call-summary-fields/calls/${eventId}/items/${a.key}`, a.body)
        : a.t === 'confirm' ? csReq<CsCall>('POST', `/call-summary-fields/calls/${eventId}/confirm`, {})
          : a.t === 'all' ? csReq<CsCall>('POST', `/call-summary-fields/calls/${eventId}/proposals/apply-all`, {})
            : csReq<CsCall>('POST', `/call-summary-fields/proposals/${a.id}/${a.t}`, {}),
    onSuccess: (d) => { qc.setQueryData(['cs-fields', 'call', eventId], d); if (d.customerId) void qc.invalidateQueries({ queryKey: ['cs-fields', 'file', d.customerId] }); },
  });
}
export function useCsFileSet(customerId: number) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (a: { key: CsKey; value: unknown }) => csReq<CsFile>('PUT', `/call-summary-fields/customers/${customerId}/items/${a.key}`, { value: a.value }),
    onSuccess: (d) => { qc.setQueryData(['cs-fields', 'file', customerId], d); void qc.invalidateQueries({ queryKey: ['customer'] }); } });
}

/* ---------- value text ---------- */
export const RET: Record<string, string> = { self: 'خودش', family: 'خانواده', none: 'هیچ‌کدام' };
export const YN: Record<string, string> = { yes: 'دارد', no: 'ندارد' };
export const DOC3 = { all: 'همه آماده‌ست', partial: 'بخشی', none: 'آماده نیست' } as const;
export const docsStatus = (d: readonly string[]) => (!d.length ? 'none' : d.length >= CS_DOCS.length ? 'all' : 'partial') as keyof typeof DOC3;
const LEGACY_DOC: Record<string, string> = { all: DOC3.all, partial: DOC3.partial, none: DOC3.none, yes: DOC3.all, no: DOC3.none };
export function rankText(v: unknown) { return v === 'unknown' ? 'نمی‌دانم' : v === 'none' ? 'ضامن ندارد' : String(v); }
export function docsText(v: unknown) {
  if (Array.isArray(v)) return v.length ? `${DOC3[docsStatus(v)]}: ${v.map((d) => DOC_LABEL[d as CsDoc] ?? d).join('، ')}` : DOC3.none;
  return LEGACY_DOC[String(v)] ?? String(v);
}
export function valueText(key: CsKey, v: unknown): string {
  if (v == null) return '';
  if (key === 'creditRank' || key === 'gRank') return rankText(v);
  if (key === 'docs') return docsText(v);
  if (key === 'sso') return RET[String(v)] ?? String(v);
  if (key === 'arrears' || key === 'bounced') return YN[String(v)] ?? String(v);
  return String(v);
}
export const mmssAt = (s: number) => { const t = Math.max(0, Math.floor(s)); return fa(`${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`); };
export const dayText = (iso: string) => new Intl.DateTimeFormat('fa-IR', { timeZone: 'Asia/Tehran', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(iso));
export const dayTimeText = (iso: string) => new Intl.DateTimeFormat('fa-IR', { timeZone: 'Asia/Tehran', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
export const shortDay = (iso: string) => new Intl.DateTimeFormat('fa-IR', { timeZone: 'Asia/Tehran', weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(iso));
export { fa };
