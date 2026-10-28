/** REL-83 (Armita crm-files-priority v1.0.1, pri.js lab()/rnote()): category pill = icon + word + reason (colour is never the only signal),
 * «+N» when more documents wait for the customer's signature, and the registrar's comment as one short line that expands on tap. */
import { useState } from 'react';
import { Ban, Check, Clock, FileText, NotebookPen, PenLine, Shield, Undo2, X } from 'lucide-react';
import { faNum } from '@/features/call-queue/api';
import type { FcCat } from './api';

export const FC_CAT_CLS: Record<string, string> = { returned: 'k1', signature_rejected: 'k2x', signature_pending: 'k2', collateral_stage: 'k3', guarantor_stage: 'k3', stale: 'k4', open_other: 'k5', completed: 'k6', cancelled: 'k7' };
const ICON: Record<string, typeof Undo2> = { k1: Undo2, k2x: Ban, k2: PenLine, k3: Shield, k4: Clock, k5: FileText, k6: Check, k7: X };
/** pri.js GT: group headings of the full list. */
export const FC_GROUP_TITLES: Record<number, string> = { 1: 'برگشتی از کارشناس ثبت', 2: 'در انتظار امضای مشتری', 3: 'مرحله‌ی وثیقه یا ضامن', 4: 'قدیمی: ۱۴ روز یا بیشتر بی‌فعالیت', 5: 'بقیه‌ی پرونده‌های باز', 6: 'تکمیل شده', 7: 'لغو شده' };
export const FC_GROUP_SHORT: Record<number, string> = { 1: 'برگشتی', 2: 'امضای مشتری', 3: 'مرحله‌ی وثیقه یا ضامن', 4: '۱۴ روز بی‌فعالیت', 5: 'بقیه‌ی باز', 6: 'تکمیل شده', 7: 'لغو شده' };

export function CatPill({ c, small }: { c: FcCat; small?: boolean }) {
  const cls = FC_CAT_CLS[c.priority_category] ?? 'k5'; const Ic = ICON[cls];
  const more = Math.max(0, (c.pending_signature_count ?? 0) - 1);
  const detail = more ? (c.label_detail ?? '').replace(/\s*\+[۰-۹0-9]+$/, '') : c.label_detail;
  return <span className={`pcat ${cls}${small ? ' sm' : ''}`} data-testid="fc-pcat" data-cat={c.priority_category}>
    <Ic aria-hidden="true" /><span className="pct"><b>{c.label_main}</b>{detail ? `: ${detail}` : ''}
      {more ? <span className="pmore" title={`${faNum(more)} سند دیگر هم منتظر امضای مشتری است`} data-testid="fc-pmore">+{faNum(more)}</span> : null}</span></span>;
}

/** One short line under the label; full text in title + on tap (aria-expanded). Optional: nothing when the registrar wrote nothing. */
export function RNote({ c }: { c: FcCat }) {
  const [open, setOpen] = useState(false);
  if (c.priority_category !== 'returned' || !c.return_note) return null;
  return <button type="button" className={`rnote${open ? ' open' : ''}`} aria-expanded={open} title={c.return_note} aria-label={`یادداشت کارشناس ثبت: ${c.return_note}`}
    onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen((v) => !v); }} data-testid="fc-rnote"><NotebookPen aria-hidden="true" /><span>{c.return_note}</span></button>;
}

const TZ = 'Asia/Tehran';
const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const dm = new Intl.DateTimeFormat('fa-IR-u-ca-persian', { timeZone: TZ, day: 'numeric', month: 'long' });
/** pri.js day(): «امروز» / «دیروز» / «۵ آبان» (Tehran calendar day). */
export function fcDay(iso: string | null | undefined, now = new Date()): string {
  if (!iso) return 'ندارد'; const d = new Date(iso); if (Number.isNaN(d.getTime())) return 'ندارد';
  const diff = Math.round((Date.parse(ymd.format(now)) - Date.parse(ymd.format(d))) / 86_400_000);
  return diff <= 0 ? 'امروز' : diff === 1 ? 'دیروز' : dm.format(d);
}
