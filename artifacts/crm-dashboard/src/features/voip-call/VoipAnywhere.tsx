/** VOIP-ANYWHERE (t836u) — placement per Armita «تماس ویپ از همه‌جا» v1.0 (nafis-design/screens/voip-everywhere, spec §۶ defaults).
 *  «تماس» = the existing VoIP click call (VoipCallBox → POST /api/voip-call/start → vcStart) for the expert's OWN customers outside the customer page.
 *  Renders nothing unless GET /voip-call/me says `anywhere: true` (flag.voip_call_anywhere[.user.<id>] + voip_call + extension + SIMOTEL-132 + salesperson).
 *  No server permission changed: the server still answers not_own_customer / expert lockdown / one_call / needs_result / no_extension.
 *  First call (SIMOTEL-132 first_call): the existing required first-call form opens by itself at pickup and again at first_form (VoipAnywhereFirstFormHost, = 47e9e2a);
 *  non-first calls open nothing — status from the Simotel CDR, note from the call summary. Calls start with fileId = null (no file task). */
import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'wouter';
import { getCustomer, getGetAuthSessionQueryKey, useGetAuthSession } from '@workspace/api-client-react';
import { Check, Copy, Flag, Headset, Lock, UserRound } from 'lucide-react';
import { announceCallSaved, faNum } from '@/features/call-queue/api';
import { copyText, useNarrow } from '@/features/call-number/CallNumber';
import { SimpleCallForm } from '@/features/team-sales/SimpleCallForm';
import { useS132First, useVcMe, useVcOwnIds, vcApi, VcError, VC_ME_KEY, vcRefresh, type VcMe } from './api';
import { VoipCallBox } from './VoipCall';
import { useVoipFormRelease } from './firstForm';
import { VCA_LABEL, vcaAutoOpen, vcaCanCall, vcaDetailButtons, vcaGate, vcaRowState, vcaSingleButton, type VcaGate } from './anywhere-rules';
import './voip-anywhere.css';

export { vcaSingleButton, vcaCanCall };
/* ---- calls started from an anywhere button (this tab only): only these get the auto-opened first-call form here ---- */
const KEY = 'vca.started';
const started = (): Set<number> => { try { return new Set((JSON.parse(sessionStorage.getItem(KEY) || '[]') as number[]).filter(Number.isSafeInteger)); } catch { return new Set(); } };
export function vcaRegister(id: number | null | undefined) {
  if (!id) return; const s = started(); s.add(id);
  try { sessionStorage.setItem(KEY, JSON.stringify([...s].slice(-20))); } catch { /* private mode: only this render */ }
  window.dispatchEvent(new CustomEvent('vca:started', { detail: id }));
}
const OPEN_EV = 'vca:first-form';
/** «فرم تماس اول» pressed inside an anywhere box → the host opens it now. */
const askOpen = (id: number) => { vcaRegister(id); window.dispatchEvent(new CustomEvent(OPEN_EV, { detail: id })); };

export function useVoipAnywhere(): VcaGate & { me: VcMe | undefined } {
  const me = useVcMe().data;
  const { data: s } = useGetAuthSession({ query: { queryKey: getGetAuthSessionQueryKey(), retry: false, staleTime: 60_000 } });
  const g = vcaGate(me, s?.user as { salespersonId?: number | null } | undefined);
  return { ...g, me };
}
/** Single-button rule for a page that already has the VoIP box («تماس سیستمی» next to it): see vcaSingleButton. */
export function useOneCallButton() { return vcaSingleButton(useVcMe().data); }
/** Customer page: single-button rule + registrar scope (vcaDetailButtons). */
export function useDetailCallButtons(customerId: number | null | undefined) {
  const me = useVcMe().data; const g = useVoipAnywhere(); const id = Number(customerId) || 0;
  const own = useVcOwnIds(id > 0 ? [id] : [], Boolean(g.on && g.registrar)).data ?? null;
  return vcaDetailButtons(me, g, own, id);
}
/** Rows without the owner (lead-intake queue, smart-filing jobs): one read-only request for the whole list, only while on. */
export function useVoipAnywhereOwn(ids: number[]) { const g = useVoipAnywhere(); return useVcOwnIds(ids, g.on).data ?? null; }
/** Rows that carry the owner (experts decide locally): only a registrar (flag.voip_call.registrar_scope) asks the server which ids are hers. */
export function useVoipAnywhereRegistrarOwn(ids: number[]) { const g = useVoipAnywhere(); return useVcOwnIds(ids, Boolean(g.on && g.registrar)).data ?? null; }

type Props = { customerId: number; customerName: string; salespersonId?: number | null; own?: boolean; ownIds?: Set<number> | null;
  /** Design `.vi`: a 44px icon button on list rows; default = the full VoipCallBox («تماس», `.btn.pri.vbtn`). */
  compact?: boolean;
  /** compact only: once this customer's call exists, show the full box in the row (lists without a lead card). Lead lists pass false: the card shows it. */
  boxOnMine?: boolean;
  /** full box only: the idle label (design: «تماس»; «تماس دوباره» after a missed incoming call). */
  label?: string; extra?: ReactNode; testId?: string };
export function VoipCallAnywhere(p: Props) {
  const g = useVoipAnywhere(); const qc = useQueryClient();
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  if (!vcaCanCall(g, p)) return null;
  const tid = p.testId ?? `vca-${p.customerId}`;
  const reg = () => vcaRegister((qc.getQueryData<VcMe>(VC_ME_KEY))?.call?.id);
  const st = vcaRowState(g.me, p.customerId);
  if (!p.compact || (st === 'mine' && p.boxOnMine !== false)) return <div className="vca vca-box" data-testid={tid} data-vca="box" onClick={(e) => e.stopPropagation()}>
    <VoipCallBox customerId={p.customerId} customerName={p.customerName} label={p.label ?? VCA_LABEL} onStarted={reg} onFirstForm={askOpen} extra={p.extra} /></div>;
  const start = async (e: MouseEvent) => {
    e.preventDefault(); e.stopPropagation(); if (busy || st !== 'idle') return; setBusy(true); setErr('');
    try { const r = await vcApi.start({ customerId: p.customerId, fileId: null }); qc.setQueryData<VcMe>(VC_ME_KEY, (o) => ({ ...(o ?? { on: true }), on: true, call: r.call })); vcaRegister(r.call?.id);
      window.dispatchEvent(new CustomEvent('vca:select', { detail: p.customerId })); }
    catch (x) { setErr(x instanceof VcError ? x.message : 'شروع تماس ناموفق بود.'); vcRefresh(qc); }
    finally { setBusy(false); }
  };
  const lockedIc = st !== 'idle'; // design: every row icon is closed while a call rings / talks / waits (incl. this customer's, shown in the lead card)
  return <span className="vca vca-row" data-testid={tid} data-vca="row" data-state={st}>
    <button type="button" className="vi" aria-disabled={lockedIc || busy || undefined} aria-busy={busy || undefined}
      aria-label={lockedIc ? 'الان تماس ممکن نیست: یک تماس در جریان است' : `تماس از تلفن ویپ با ${p.customerName}`}
      title={lockedIc ? 'یک تماس در جریان است' : 'تماس از تلفن ویپ'} onClick={(e) => { if (lockedIc) { e.preventDefault(); e.stopPropagation(); return; } void start(e); }}
      data-testid={`${tid}-btn`} data-locked={lockedIc ? '1' : undefined}>{lockedIc ? <Lock size={20} aria-hidden="true" /> : <Headset size={20} aria-hidden="true" />}</button>
    {err ? <span className="dp-err vc-err" role="alert" data-testid={`${tid}-err`}>{err}</span> : null}
  </span>;
}

/** Design `lead_*` / `smart_list` card («صف لید»): the selected own lead — name, #id, «تماس اول», source, full phone + copy (tel: under 700px),
 *  then the VoipCallBox («تماس» primary + «مشتری»; ring / talk / first-call form / done panels come from the box itself).
 *  Selected = the lead whose call exists, else the last row whose icon was pressed, else the first own row. */
export function VcaLeadCard({ items, source, ownIds, testId = 'vca-lead' }: { items: { customerId: number; name: string; salespersonId?: number | null; at?: string | null; source?: string }[];
  source: string; ownIds?: Set<number> | null; testId?: string }) {
  const g = useVoipAnywhere();
  const [pick, setPick] = useState<number | null>(null);
  useEffect(() => { const on = (e: Event) => setPick(Number((e as CustomEvent).detail)); window.addEventListener('vca:select', on); return () => window.removeEventListener('vca:select', on); }, []);
  const callCid = g.me?.call?.customerId;
  const sel = items.find((i) => i.customerId === callCid) ?? items.find((i) => i.customerId === pick) ?? items[0];
  const cid = sel?.customerId ?? 0;
  const first = useS132First(cid, Boolean(g.on && cid));
  const cust = useQuery({ queryKey: ['voip-call', 'anywhere-lead', cid], queryFn: () => getCustomer(cid), enabled: Boolean(g.on && cid), staleTime: 60_000, retry: false });
  if (!g.on || !sel) return null;
  const phone = (cust.data as { phone?: string } | undefined)?.phone ?? '';
  return <article className="vca-lead" aria-label={`لید جاری: ${sel.name}`} data-testid={testId} data-customer={sel.customerId}>
    <div className="vca-vh"><h3>{sel.name}</h3><span className="vca-cid">#{faNum(sel.customerId)}</span>
      {first.data?.firstCall ? <span className="vca-chip g" data-testid={`${testId}-first`}><Flag size={14} aria-hidden="true" />تماس اول</span> : null}
      <span className="vca-chip b">{sel.source ?? source}</span></div>
    {sel.at ? <p className="vca-vm">ثبت {sel.at}</p> : null}
    {phone ? <p className="vca-phr"><VcaPhone phone={phone} testId={`${testId}-ph`} /></p> : null}
    <VoipCallAnywhere customerId={sel.customerId} customerName={sel.name} own ownIds={ownIds} testId={`${testId}-box`}
      extra={<Link href={`/customers/${sel.customerId}`} className="btn btn-ghost" data-testid={`${testId}-open`}><UserRound size={16} aria-hidden="true" /> مشتری</Link>} />
  </article>;
}

/** Design number format: the full number in one LTR run, no separators; copy button; a tel: link (SIM) only under 700px. */
function VcaPhone({ phone, testId }: { phone: string; testId: string }) {
  const narrow = useNarrow(); const [ok, setOk] = useState(false);
  const d = phone.replace(/[۰-۹]/g, (x) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(x))).replace(/^\+98/, '0').replace(/[^\d*]/g, '');
  if (!d) return null;
  const masked = d.includes('*');
  const n = <bdi dir="ltr" className="vca-num" data-testid={`${testId}-num`}>{faNum(d)}</bdi>;
  return <span className="vca-ph" data-testid={testId}>
    {narrow && !masked ? <a href={`tel:${d}`} aria-label={`تماس با سیم‌کارت گوشی با ${faNum(d)}`}>{n}</a> : n}
    {masked ? null : <button type="button" className="vca-cp" aria-label="کپی شماره" title="کپی شماره" data-testid={`${testId}-copy`}
      onClick={() => { void copyText(d).then((x) => { setOk(x); window.setTimeout(() => setOk(false), 1500); }); }}>{ok ? <Check size={18} aria-hidden="true" /> : <Copy size={18} aria-hidden="true" />}</button>}
  </span>;
}

/** Mounted once in CrmShell. Opens the existing required first-call form (SimpleCallForm voip mode: no close before save, «تماس اول» chip)
 *  for an anywhere-started FIRST call at the same moments as FIRSTFORM-VOIP (47e9e2a): at pickup (customer dialed / talking) and again at
 *  first_form if it is not saved yet. Never doubled: skipped while any first-call form (page flow: Today / customer page) is open; a mandatory
 *  reminder popup stays on top first. A talk-time form is closed again (draft kept) when Simotel says no answer (useVoipFormRelease). */
export function VoipAnywhereFirstFormHost() {
  const g = useVoipAnywhere(); const qc = useQueryClient();
  const { data: s } = useGetAuthSession({ query: { queryKey: getGetAuthSessionQueryKey(), retry: false, staleTime: 60_000 } });
  const [form, setForm] = useState<{ callId: number; customer: { id: number; name: string; phone: string; priority: number | null } } | null>(null);
  const [saved, setSaved] = useState(false);
  const shown = useRef<Set<string>>(new Set()); const pending = useRef<string | null>(null); const [tick, setTick] = useState(0);
  const call = g.me?.call ?? null;
  const open = async (id: number, key: string) => {
    if (!call || call.id !== id || shown.current.has(key) || pending.current === key) return;
    if (document.querySelector('.rmm-root [data-testid=rm-overlay]') || document.querySelector('[data-testid=ts-simple-form]')) return;
    pending.current = key;
    let c: { id: number; name: string; phone: string; priority: number | null } = { id: call.customerId, name: call.customerName ?? '', phone: '', priority: null };
    try { const f: any = await getCustomer(call.customerId); c = { id: call.customerId, name: f?.name ?? c.name, phone: f?.phone ?? '', priority: f?.priority ?? null }; } catch { /* name from the call */ }
    pending.current = null;
    if (shown.current.has(key) || document.querySelector('[data-testid=ts-simple-form]')) return; // another page opened it meanwhile
    shown.current.add(key); setSaved(false); setForm({ callId: id, customer: c });
  };
  useEffect(() => {
    // «فرم تماس اول» pressed in a box: allow this call's form again
    const on = (e: Event) => { const id = Number((e as CustomEvent).detail); for (const k of [...shown.current]) if (k.startsWith(`${id}:`) && e.type === OPEN_EV) shown.current.delete(k); setTick((x) => x + 1); };
    window.addEventListener('vca:started', on); window.addEventListener(OPEN_EV, on);
    return () => { window.removeEventListener('vca:started', on); window.removeEventListener(OPEN_EV, on); };
  }, []);
  const want = form ? null : vcaAutoOpen(g.me, g, started(), shown.current);
  useEffect(() => {
    if (!want) return;
    // after the page's own flow (TodayPage / customer page) had its chance; then every 1.5 s until the reminder popup is gone
    const t0 = window.setTimeout(() => void open(want.id, want.key), 700); const iv = window.setInterval(() => void open(want.id, want.key), 1500);
    return () => { window.clearTimeout(t0); window.clearInterval(iv); };
  }, [want?.key, tick]); // eslint-disable-line react-hooks/exhaustive-deps
  useVoipFormRelease(form ? { callId: form.callId } : null, saved, () => setForm(null));
  if (!form) return null;
  const end = () => { const v = form; setForm(null); void vcApi.dismiss(v.callId).catch(() => undefined).finally(() => vcRefresh(qc)); };
  // portal: the host sits in the top bar; the form is a full-screen dialog
  return createPortal(<div className="vca-ff" data-testid="vca-first-form"><SimpleCallForm customer={form.customer} userId={s?.user?.id} onClose={end} voip={{ callId: form.callId }}
    onDone={(r) => { setSaved(true); announceCallSaved(r.callLogId, form.customer.id); vcRefresh(qc); }} onNext={end} /></div>, document.body);
}
