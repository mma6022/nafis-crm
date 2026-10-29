/** FILES-61 «پرونده‌های من» تک‌کارتی client. Only users 8/2/3 ever call /files-carousel/config; everyone else never touches it. */
import { useQuery } from '@tanstack/react-query';
import { DpError } from '@/features/daily-plan/api';

export const FC_USERS: Readonly<Record<number, number>> = { 8: 6, 2: 3, 3: 4 };
async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, { method, credentials: 'include', headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text(); let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) throw new DpError((data && typeof data.message === 'string' && data.message) || 'انجام نشد. دوباره تلاش کن.', res.status, data?.error ?? '', data?.details ?? null);
  return data as T;
}
export type FcCard = { fileId: number; customerId: number; customerName: string; phone: string | null; type: string; typeLabel: string; group: string; groupLabel: string; stage: string;
  status: string; isDraft: boolean; businessStatus: string; createdAt: string; returnedToday: boolean;
  lastFollowUp: { at: string; atTehran: string | null; source: string; outcome: string | null; outcomeLabel: string | null } | null;
  position: number; state: 'done' | 'current' | 'pending'; reason: string | null; ask: string | null;
  todayFollowUp: { at: string; outcome: string; outcomeLabel: string | null; note: string } | null; fc?: FcCat | null };
/** REL-83 (crm-files-priority v1.0.1) category fields; present only while flag.fc_categories is on. */
export type FcCategoryCode = 'returned' | 'signature_rejected' | 'signature_pending' | 'collateral_stage' | 'guarantor_stage' | 'stale' | 'open_other' | 'completed' | 'cancelled';
export type FcReturnType = 'missing_documents' | 'guarantor_documents_missing' | 'collateral_rejected' | 'payslip_missing' | 'id_card_unreadable' | 'other';
export type FcCat = { priority_group: number; priority_category: FcCategoryCode; sub_rank: number; label_main: string; label_detail: string | null; label: string;
  return_type: FcReturnType | null; return_note: string | null; returned_at: string | null; returned_by: number | null; return_source?: FcReturnSource | null;
  signature_type: 'contract' | 'replacement_contract' | 'addendum' | 'invoice' | null; signature_status: 'pending' | 'rejected' | null; signature_sent_at: string | null;
  signature_reject_reason: string | null; pending_signature_count: number; pending_item: string | null; last_activity_at: string | null; idle_days: number | null };
export type FcListItem = FcCat & { file_id: number; customer_id: number; customer_name: string; phone_masked: string | null; phone?: string | null; followed_up_today: boolean;
  returned_unopened: boolean; is_closed: boolean; closed_at: string | null; can_follow_up: boolean; can_cancel: boolean; can_edit: boolean };
export type FcList = { q: string; page: number; page_size: number; pages: number; total: number; group_counts: Record<string, number>; group_labels: Record<string, string>; items: FcListItem[] };
/** PM 29 Oct: who returned the file → the bar/badge source line. */
export type FcReturnSource = 'registrar' | 'funder';
export type FcLateReturn = { type: 'file_returned'; file_id: number; customer_name: string; return_type: FcReturnType | null; return_note: string | null; returned_at: string | null; return_source?: FcReturnSource | null };
export type FcView = { enabled: true; date: string; total: number; done: number; index: number | null; currentFileId: number | null; orderSource: 'assistant' | 'default'; waiting?: { total: number; groups: Array<{ code: string; label: string; count: number }> };
  outcomes: { code: string; label: string }[]; noteMax: number; cancelReasonMax?: number; cards: FcCard[];
  categories?: boolean; mode?: 'cards' | 'list'; lateReturns?: FcLateReturn[] };
export const fcApi = {
  config: () => req<{ enabled: boolean }>('GET', '/files-carousel/config'),
  today: () => req<FcView>('GET', '/files-carousel/today'),
  list: (p: { q: string; page: number; pageSize: number }) => req<FcList>('GET', `/files-carousel/list?${new URLSearchParams({ q: p.q, page: String(p.page), page_size: String(p.pageSize) })}`),
  opened: (fileId: number) => req<{ ok: true; fileId: number; cleared: number }>('POST', '/files-carousel/opened', { fileId }),
  tel: (fileId: number) => req<{ fileId: number; tel: string | null }>('GET', `/files-carousel/tel/${fileId}`),
  followup: (b: { fileId: number; outcome: string; note?: string; cancelReason?: string }) => req<{ ok: true; fileId: number; view: FcView }>('POST', '/files-carousel/followup', b),
};
export const useFcConfig = (userId: number | null | undefined) =>
  useQuery({ queryKey: ['files-carousel', 'config', userId], queryFn: fcApi.config, enabled: userId != null && FC_USERS[userId] != null, retry: false, staleTime: 60_000 });
