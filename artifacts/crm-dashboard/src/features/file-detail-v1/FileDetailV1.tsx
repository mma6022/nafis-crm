/** FILE-DETAIL v1.1 (Armita, approved by Mohammad t819s3315): the loan-file page behind flag.file_detail_v1.user.N.
 *  Same data and mutations as the old page; the old stage panel stays reachable under «جزئیات و کارهای بیشتر این مرحله».
 *  Contract text/templates are never touched here; «ارسال دوباره‌ی لینک امضا» re-sends the SAME link of the SAME contract (server-limited). */
import React, { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'wouter';
import { useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft, Calendar, Check, ChevronDown, ChevronLeft, ChevronRight, CircleAlert, Clock, Coins, Copy, Eye, File as FileIcon, FileText, Flag,
  History as HistoryIcon, IdCard, Lock, EllipsisVertical, PenLine, Plus, RefreshCw, Send, Shield, Upload, User, X, Zap,
} from 'lucide-react';
import { useGetCustomer, useUploadLoanApplicationDocument, getGetCustomerQueryKey } from '@workspace/api-client-react';
import { ACTION_ROLE_NAMES, BUSINESS_STATUS_LABELS, LOAN_STAGE_LABELS, loanBusinessStatus } from '@/lib/loan-labels';
// @ts-ignore -- untyped .mjs helper, imported the same way as CaseHistoryDialog
import { historyActionLabel } from '@/lib/loan-history-fa.mjs';
import { fetchHistory, postNote, type HistoryEvent } from '@/loan-case-history/api';
import { docClientCheck, docServerError, DocMissingChip, DOC_UPLOAD_MAX_BYTES, DOC_UPLOAD_TYPES, type DocUpErr } from '@/features/doc-upload/DocUploadError';
import { useDiagnostics } from '@/diagnostics/DiagnosticsProvider';
import { LoanCaseCancellation } from '@/components/loan-applications/LoanCaseCancellation';
import { SmartFilingButton } from '@/features/smart-filing/SmartFilingButton';
import { NotesColumn } from './NotesColumn';
import { faAmount, fd, leftText, longDate, resendSignatureLink, shortDay, sizeFa, useLinkResends, whenShort, dayKey, dayLabel, hm, type ResendItem } from './fdv1-api';
import './fdv1.css';

type Step = { id: string; label: string; stages: string[] };
type Tab = 'ov' | 'docs' | 'contract' | 'hist' | 'chat';
type Props = {
  app: any; user: any; appId: number;
  steps: Step[]; currentStepIndex: number; stageLabel: string;
  canUploadDocs: boolean; canSubmitDocs: boolean;
  submitDocs: { mutate: (v: { id: number }, o?: { onSuccess?: () => void; onError?: (e: unknown) => void }) => void; isPending: boolean };
  legacy: ReactNode;
};
type Modal = null | { k: 'up'; doc: any } | { k: 'wz'; n: 1 | 2 } | { k: 'rs'; item: ResendItem; title: string };

const I = { className: 'i', 'aria-hidden': true } as const;
const hasFile = (d: any) => d?.fileAvailable === true;
type DSt = 'ok' | 'wait' | 'miss' | 'bad' | 'rej';
const DST: Record<DSt, [string, React.ComponentType<any>, string]> = {
  ok: ['s', Check, 'تأیید شده'], wait: ['b', Clock, 'در انتظار بررسی'], miss: ['', Upload, 'در انتظار بارگذاری'], bad: ['r', CircleAlert, 'نقص مدرک'], rej: ['r', X, 'رد شده'],
};
const docSt = (d: any): DSt => !hasFile(d) ? 'miss' : d.status === 'approved' ? 'ok' : d.status === 'incomplete' ? 'bad' : d.status === 'rejected' ? 'rej' : 'wait';
const docName = (d: any) => d.label || d.original_name || d.originalName || 'مدرک';
const IDL: Record<string, string> = { national_card_front: 'روی کارت ملی', national_card_back: 'پشت کارت ملی', birth_cert_p1: 'صفحه‌ی اول شناسنامه', birth_cert_p2: 'صفحه‌ی دوم شناسنامه', birth_cert_p3: 'صفحه‌ی سوم شناسنامه' };
const idSt = (d: any): DSt => !d.fileAvailable && !d.approvedAt ? 'miss' : d.approvedAt ? 'ok' : d.reviewReason ? 'bad' : 'wait';
const latin = (s: string) => s.replace(/[۰-۹]/g, d => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d))).replace(/[^\d+]/g, '').replace(/^\+98/, '0');
const GENERIC = 'لینک فرستاده نشد. یک بار دیگر امتحان کن؛ اگر باز هم نشد، «گزارش خطا» را بزن.';

async function copyText(t: string) {
  try { if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(t); return true; } } catch { /* fall back */ }
  try { const ta = document.createElement('textarea'); ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select(); const ok = document.execCommand('copy'); ta.remove(); return ok; } catch { return false; }
}

/** Upload error texts — identical to the live DocUploadError (Armita upload-errors spec), in the file-detail markup. */
function UpErrBox({ err, onPick, onRetry, onGo }: { err: DocUpErr; onPick: () => void; onRetry: () => void; onGo: (id: number) => void }) {
  const mb = (b: number) => fd(String(Math.round((b / 1048576) * 10) / 10)).replace('.', '٫');
  let body: ReactNode; let btn: ReactNode;
  const B = (t: string, on: () => void, Ic: React.ComponentType<any>) => <button className="btn gh sm" type="button" onClick={on}><Ic {...I} />{t}</button>;
  switch (err.kind) {
    case 'turn': body = err.name ? <>مدارک پرونده‌ها به ترتیب باز می‌شود؛ اول پرونده‌ی <b>{err.name}</b>{err.fileId ? <> <span className="cid">#{fd(err.fileId)}</span></> : null} را کامل کن.</> : <>مدارک پرونده‌ها به ترتیب باز می‌شود؛ اول پرونده‌ی نوبت را کامل کن.</>;
      btn = err.fileId ? B(`رفتن به پرونده‌ی ${err.name ?? fd(err.fileId)}`, () => onGo(err.fileId!), ArrowLeft) : null; break;
    case 'size': body = err.mb ? <>حجم این فایل {mb(err.mb)} مگابایت است؛ حداکثر {mb(err.maxMb)} مگابایت مجاز است. فایل کوچک‌تری انتخاب کن.</> : <>حجم این فایل بیشتر از حد مجاز است؛ حداکثر {mb(err.maxMb)} مگابایت مجاز است. فایل کوچک‌تری انتخاب کن.</>;
      btn = B('انتخاب فایل دیگر', onPick, FileIcon); break;
    case 'type': body = <>این نوع فایل پذیرفته نمی‌شود. فقط {err.list} را می‌شود بارگذاری کرد.</>; btn = B('انتخاب فایل دیگر', onPick, FileIcon); break;
    case 'network': body = <>اتصال برقرار نشد و مدرک بارگذاری نشد. اینترنت را بررسی کن و دوباره امتحان کن.</>; btn = B('دوباره امتحان کن', onRetry, RefreshCw); break;
    default: body = <>مدرک بارگذاری نشد. یک بار دیگر امتحان کن؛ اگر باز هم نشد، «گزارش خطا» را بزن.</>; btn = B('دوباره امتحان کن', onRetry, RefreshCw);
  }
  return <div className="ferr box" role="alert" id="fdv1-uperr" data-kind={err.kind} data-testid="fdv1-upload-error"><CircleAlert {...I} /><div><span>{body}</span>{btn ? <div className="fa2">{btn}</div> : null}</div></div>;
}

function ModalShell({ cls, title, sub, onClose, children, foot, top, diag }: { cls: string; title: string; sub: string; onClose: () => void; children: ReactNode; foot: ReactNode; top?: ReactNode; diag?: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    box.current?.querySelector<HTMLElement>('button, [href], textarea, input')?.focus();
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('keydown', esc); prev?.focus?.(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return <div className={`mx${cls.startsWith('cf') ? ' cfx' : ''}`} onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
    <div className={`md ${cls}`} role="dialog" aria-modal="true" aria-labelledby="fdv1-mdt" ref={box}>
      <header className="mh"><div className="t"><h2 id="fdv1-mdt">{title}</h2><p>{sub}</p>{top}</div>
        {diag ? <button className="btn lk sm mdg" type="button" onClick={diag}><Flag {...I} />گزارش خطا</button> : null}
        <button className="ib" type="button" aria-label="بستن" onClick={onClose}><X {...I} /></button></header>
      <div className="mb">{children}</div><div className="mf">{foot}</div>
    </div></div>;
}

function WzSteps({ n }: { n: 1 | 2 }) {
  const L = ['مرور مدارک', 'پیام و ارسال'];
  return <ol className="wst" aria-label="مراحل">{L.map((l, i) => { const k = i + 1, dn = k < n, cur = k === n;
    return <React.Fragment key={k}>{i ? <li className={`bar${dn || cur ? ' on' : ''}`} aria-hidden="true" /> : null}
      <li className={dn ? 'dn' : ''} aria-current={cur ? 'step' : undefined}><b>{dn ? <Check {...I} /> : fd(k)}</b><span className="l">{l}</span></li></React.Fragment>; })}</ol>;
}

const histIcon = (a: string) => {
  const k = a.split(':')[0];
  if (k === 'signature-link-resent') return Send;
  if (/cancel/.test(k)) return X;
  if (/reject|incomplete|defect|return/.test(k)) return CircleAlert;
  if (/sign/.test(k)) return PenLine;
  if (/approve|verified|confirm|complete/.test(k)) return Check;
  if (/submit|send/.test(k)) return Send;
  if (/amount|terms|reconcil/.test(k)) return Coins;
  if (/create|register|added/.test(k)) return Plus;
  return HistoryIcon;
};
type HCat = 'all' | 'step' | 'doc' | 'ct';
const histCat = (a: string): Exclude<HCat, 'all'> => {
  const k = a.split(':')[0];
  if (/contract|sign|primary|amendment|invoice|replacement/.test(k)) return 'ct';
  if (/doc|identity|collateral|physical|guarantor|_corrected|_incomplete/.test(k)) return 'doc';
  return 'step';
};
const SIGNED = new Set(['primary_signature_verified', 'approved-primary-signature-verified', 'confirm-signed-primary', 'toman-replacement-signature-verified', 'amendment_signature_verified']);
const sysText = (a: string) => { const k = a.split(':')[0];
  if (k === 'created' || k === 'customer_portal_created') return 'پرونده ثبت شد';
  if (SIGNED.has(k)) return 'قرارداد امضا شد';
  if (k === 'submit-customer-documents') return 'پرونده برای کارشناس ثبت فرستاده شد';
  if (k === 'cancel-case') return 'پرونده لغو شد';
  return null; };
// r2 §4: each system-line event has its own icon
const sysKind = (a: string): 'created' | 'signed' | 'sent' | 'canceled' => { const k = a.split(':')[0];
  return k === 'created' || k === 'customer_portal_created' ? 'created' : SIGNED.has(k) ? 'signed' : k === 'cancel-case' ? 'canceled' : 'sent'; };
const histLabel = (a: string) => String(historyActionLabel(a)).replace(/\s*\(شناسه[^)]*\)\s*$/, '');

export function FileDetailV1(p: Props) {
  const { app, user, appId } = p;
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const diag = useDiagnostics();
  const openDiag = diag ? () => diag.open() : undefined;
  const [tab, setTab] = useState<Tab>('ov');
  const [stepsOpen, setStepsOpen] = useState(false);
  const [more, setMore] = useState(false);
  const [lgx, setLgx] = useState(false);
  const [modal, setModal] = useState<Modal>(null);
  const [toast, setToast] = useState('');
  const [copied, setCopied] = useState(false);
  const lgxRef = useRef<HTMLDetailsElement>(null);

  const biz = loanBusinessStatus(app);
  const closed = biz === 'completed' || biz === 'canceled' || app.status === 'rejected';
  const turn: 'me' | 'closed' | string = closed ? 'closed' : app.actionRequired ? 'me'
    : biz === 'waiting_customer_signature' ? 'مشتری' : app.actionRole ? (app.actionRole === 'registrar' ? 'کارشناس ثبت' : ACTION_ROLE_NAMES[app.actionRole] || '') : '';
  const custDocs: any[] = (app.documents || []).filter((d: any) => d.source !== 'identity_vault' && !['guarantee_check', 'guarantee_promissory'].includes(d.requirement_key || d.requirementKey));
  const idDocs: any[] = app.identityDocuments || [];
  const gens: any[] = app.generatedDocuments || [];
  const hasDocs = custDocs.length > 0;
  const missing = custDocs.filter(d => ['miss', 'bad', 'rej'].includes(docSt(d)));
  const allUploaded = custDocs.length > 0 && missing.length === 0;
  const docStage = app.stage === 'customer_documents_upload';

  const cust = useGetCustomer(Number(app.customerId), { query: { queryKey: getGetCustomerQueryKey(Number(app.customerId)), enabled: !!app.customerId, staleTime: 60_000 } });
  const phone = latin(String((cust.data as any)?.phone || ''));
  const resends = useLinkResends(appId, true);
  const [tick, setTick] = useState(0);
  const [rsLine, setRsLine] = useState<Record<number, { kind: 'wait' } | { kind: 'error' } | { kind: 'turn'; fileId: number | null; name: string | null }>>({});
  const [sending, setSending] = useState(false);
  const [upFile, setUpFile] = useState<File | null>(null);
  const [upErr, setUpErr] = useState<DocUpErr | null>(null);
  const [wzNote, setWzNote] = useState('');
  const [wzErr, setWzErr] = useState<DocUpErr | null>(null);
  const pick = useRef<HTMLInputElement>(null);
  const upload = useUploadLoanApplicationDocument({ mutation: {
    onError: e => setUpErr(docServerError(e)),
    onSuccess: () => { void qc.invalidateQueries(); setModal(null); setUpFile(null); show('مدرک بارگذاری شد.'); },
  } });

  // root classes: live-shell mapping; full-screen notes on mobile; --vh for the design's sticky notes column
  useEffect(() => {
    const h = document.documentElement; h.classList.add('fdv1-on');
    const vh = () => h.style.setProperty('--vh', `${window.innerHeight}px`); vh(); window.addEventListener('resize', vh);
    return () => { h.classList.remove('fdv1-on', 'fdv1-chv'); window.removeEventListener('resize', vh); };
  }, []);
  useEffect(() => { document.documentElement.classList.toggle('fdv1-chv', tab === 'chat'); if (tab === 'chat') window.scrollTo(0, 0); }, [tab]);
  useEffect(() => { if (tab === 'docs' && !hasDocs) setTab('ov'); }, [tab, hasDocs]);
  useEffect(() => { const t = window.setInterval(() => setTick(x => x + 1), 1000); return () => window.clearInterval(t); }, []);
  useEffect(() => { if (!toast) return; const t = window.setTimeout(() => setToast(''), 3200); return () => window.clearTimeout(t); }, [toast]);
  useEffect(() => { if (!copied) return; const t = window.setTimeout(() => setCopied(false), 1600); return () => window.clearTimeout(t); }, [copied]);
  const show = (t: string) => setToast(t);

  const leftFor = (it: ResendItem) => {
    if (!resends.data) return 0;
    void tick;
    return Math.max(0, Math.ceil(it.retryAfterSeconds - (Date.now() - resends.data.at) / 1000));
  };

  // ---------- history (in the page, not a dialog) ----------
  const [hist, setHist] = useState<HistoryEvent[]>([]);
  const [hCursor, setHCursor] = useState<string | null>(null);
  const [hState, setHState] = useState<'loading' | 'ok' | 'error'>('loading');
  const [hCat, setHCat] = useState<HCat>('all');
  const loadHist = async (before: string | null) => {
    try {
      const pg = await fetchHistory(appId, before, 30);
      setHist(prev => { const m = new Map<number, HistoryEvent>(); [...(before ? prev : []), ...pg.items].forEach(e => m.set(e.id, e)); return [...m.values()].sort((a, b) => b.id - a.id); });
      setHCursor(pg.nextCursor); setHState('ok');
    } catch { if (!before) setHState('error'); }
  };
  const appStamp = `${app.updatedAt}|${app.stage}`;
  useEffect(() => { void loadHist(null); }, [appId, appStamp]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------- contracts ----------
  const contracts = useMemo(() => {
    const items = resends.data?.items || [];
    type Row = { key: string; gen: number; doc: any | null; rs: ResendItem | null };
    const rows: Row[] = gens.map(d => ({ key: `d${d.id}`, gen: Number(d.contractGenerationId ?? d.contract_generation_id ?? 0), doc: d, rs: null as ResendItem | null }));
    for (const it of items) {
      const r = rows.find(x => x.gen === it.generationId && x.doc && !x.doc.signed);
      if (r) r.rs = it; else rows.push({ key: `g${it.generationId}`, gen: it.generationId, doc: null, rs: it });
    }
    const prim = rows.filter(r => !r.doc || r.doc.kind === 'primary').sort((a, b) => a.gen - b.gen);
    const latest = prim[prim.length - 1];
    return rows.map(r => {
      const isPrim = !r.doc || r.doc.kind === 'primary';
      const title = !isPrim ? (r.doc.kind === 'final_invoice' ? 'صورت‌حساب نهایی' : r.doc.kind === 'amendment' ? 'الحاقیه‌ی قرارداد' : 'سند قرارداد')
        : prim.length > 1 && prim.indexOf(r) > 0 ? 'قرارداد جایگزین' : 'قرارداد اولیه';
      const old = isPrim && r !== latest && (!!r.doc?.superseded || r.doc?.current === false || !!r.rs === false && !!latest?.rs);
      return { ...r, title, old };
    }).sort((a, b) => Number(a.old) - Number(b.old) || b.gen - a.gen);
  }, [gens, resends.data]);
  const currentCt = contracts.find(c => !c.old);
  const sysLines = useMemo(() => hist.flatMap(e => { const t = sysText(e.action); return t ? [{ id: String(e.id), at: e.createdAt, text: t, kind: sysKind(e.action) }] : []; }), [hist]);
  // Armita r1 §8: mobile top-bar title names the file (desktop keeps the shell title)
  useEffect(() => { window.dispatchEvent(new CustomEvent('nafis:page-title', { detail: { title: `پرونده‌ی ${fd(app.id)}` } }));
    return () => { window.dispatchEvent(new CustomEvent('nafis:page-title', { detail: { title: null } })); }; }, [app.id]);

  const doResend = async (it: ResendItem) => {
    if (sending) return;
    setSending(true);
    const r = await resendSignatureLink(appId, it.generationId);
    setSending(false); setModal(null);
    if (r.kind === 'ok') { setRsLine(x => { const n = { ...x }; delete n[it.generationId]; return n; }); show('لینک امضا دوباره فرستاده شد.'); void loadHist(null); }
    else setRsLine(x => ({ ...x, [it.generationId]: r.kind === 'wait' ? { kind: 'wait' } : r.kind === 'turn' ? r : { kind: 'error' } }));
    await resends.refetch();
  };

  // ---------- pieces ----------
  const go = (t: Tab) => { setTab(t); setMore(false); };
  const openUpload = (doc: any) => { setUpFile(null); setUpErr(null); setModal({ k: 'up', doc }); };
  const custName = app.customerName || 'مشتری';
  const isMine = user?.role === 'salesperson' && user?.salespersonId != null && app.customerSalespersonId === user.salespersonId;

  const turnChip = turn === 'me' ? <span className="chip g"><Zap {...I} />اقدام با شماست</span>
    : turn === 'closed' ? <span className="chip"><Lock {...I} />پرونده بسته شده</span>
    : turn ? <span className="chip">نوبت اقدام: {turn}</span> : null;
  const stepDate = (s: Step) => {
    const h = (app.history || []) as any[];
    const e = h.filter(x => s.stages.includes(x.from_stage) && !s.stages.includes(x.to_stage)).pop();
    return e ? shortDay(e.created_at) : '';
  };
  const cur = p.currentStepIndex;
  const nSteps = p.steps.length;
  const path = <div className={`path${stepsOpen ? ' open' : ''}`} data-testid="fdv1-path">
    <div className="pl-r"><span className="pl-t">مسیر پرونده</span>
      <span className="pl-n">{closed ? <b>{BUSINESS_STATUS_LABELS[biz as string] || 'پرونده بسته شده'}</b> : cur >= 0 ? <>مرحله‌ی {fd(cur + 1)} از {fd(nSteps)}: <b>{LOAN_STAGE_LABELS[app.stage as string] || p.steps[cur]?.label || p.stageLabel}</b></> : <b>{p.stageLabel}</b>}</span>
      <button className="btn lk sm" type="button" aria-expanded={stepsOpen} onClick={() => setStepsOpen(o => !o)}>{stepsOpen ? 'بستن' : 'همه‌ی مراحل'}<ChevronDown className={`i${stepsOpen ? ' up' : ''}`} aria-hidden /></button></div>
    <div className="pl-bar" aria-hidden="true">{p.steps.map((s, i) => <i key={s.id} className={i < cur ? 'dn' : i === cur ? 'now' : undefined} />)}</div>
    {stepsOpen ? <ol className="pl-list">{p.steps.map((s, i) => { const st = i < cur ? 'dn' : i === cur ? 'now' : '';
      return <li key={s.id} className={st || undefined} aria-current={st === 'now' ? 'step' : undefined}><b>{st === 'dn' ? <Check {...I} /> : fd(i + 1)}</b><span className="l">{s.label}</span>
        <span className="m">{st === 'dn' ? stepDate(s) : st === 'now' ? (turn === 'me' ? 'الان: اقدام با شماست' : turn && turn !== 'closed' ? `الان: نوبت اقدام: ${turn}` : '') : ''}</span></li>; })}</ol> : null}
  </div>;

  const head = <section className="card fhd" aria-label="سربرگ پرونده">
    <div className="crow"><nav className="crumb" aria-label="مسیر"><Link href="/loan-applications"><ChevronRight {...I} />پرونده‌های من</Link></nav>
</div>
    <div className="fhd-r1"><div className="who"><span className="eyb">پرونده‌ی تسهیلات {fd(app.id)}، {app.planName ? (/^\s*طرح/.test(app.planName) ? app.planName : `طرح ${app.planName}`) : 'طرح ثبت نشده'}</span>
      <div className="nmr"><h2>{custName}</h2>{app.customerId ? <button className="cid" type="button" aria-label={`شناسه‌ی ${fd(app.customerId)}، کپی`} onClick={() => { void copyText(`#${app.customerId}`).then(ok => ok && show('کپی شد')); }}>#{fd(app.customerId)}<Copy className="i cpi" aria-hidden /></button> : null}</div>
      {phone ? <span className="ph big"><a className="phn" href={`tel:${phone}`} dir="ltr" aria-label={`تماس با ${fd(phone)}`}>{fd(phone)}</a>
        <button className={`phc${copied ? ' done' : ''}`} type="button" aria-label={`کپی شماره‌ی ${fd(phone)}`} onClick={() => { void copyText(phone).then(ok => { if (ok) { setCopied(true); show('کپی شد'); } }); }}>{copied ? <Check {...I} /> : <Copy {...I} />}<span>کپی</span></button></span> : null}</div>
      <div className="fhd-act">{app.customerId ? <Link className="btn gh sm" href={`/customers/${app.customerId}`}><User {...I} />پرونده‌ی مشتری</Link> : null}
        {app.customerId ? <Link className="btn gh sm" href={`/customers/${app.customerId}?caseCall=${app.id}`} data-testid="link-case-call">ثبت تماس این پرونده</Link> : null}
        <button className="ib wb" type="button" aria-label="کارهای بیشتر: ثبت هوشمند با سارینا، لغو پرونده" aria-haspopup="menu" aria-expanded={more} onClick={() => setMore(m => !m)}><EllipsisVertical {...I} /></button>
        {more ? <div className="fmenu" role="menu" onKeyDown={e => { if (e.key === 'Escape') setMore(false); }}><SmartFilingButton applicationId={appId} /><LoanCaseCancellation application={app} /></div> : null}</div></div>
    <div className="fhd-chips">{BUSINESS_STATUS_LABELS[biz as string] ? <span className="chip b">{BUSINESS_STATUS_LABELS[biz as string]}</span> : null}{turnChip}
      <span className="chip"><User {...I} />کارشناس فروش: {app.customerSalespersonName || 'بدون تخصیص'}{isMine ? ' (شما)' : ''}</span>
      {app.createdAt ? <span className="chip"><Calendar {...I} />ثبت: {shortDay(app.createdAt)}</span> : null}</div>
    {path}
  </section>;

  const docsLeft = !closed && docStage ? missing.length : 0;
  const tabs = <nav className="stabs" aria-label="بخش‌های پرونده">{([['ov', 'خلاصه'], hasDocs ? ['docs', 'مدارک'] : null, ['contract', 'قراردادها'], ['hist', 'تاریخچه'], ['chat', 'یادداشت‌ها']].filter(Boolean) as [Tab, string][]).map(([k, t]) =>
    <a key={k} className={`st-i${k === 'chat' ? ' mob' : ''}`} href={`#${k}`} aria-current={tab === k ? 'page' : undefined} data-testid={`fdv1-tab-${k}`}
      aria-label={k === 'docs' && docsLeft ? `${t}، ${fd(docsLeft)} مدرک مانده` : t} onClick={e => { e.preventDefault(); go(k); }}>
      {t}{k === 'docs' && docsLeft ? <span className="bdg n" aria-hidden="true">{fd(docsLeft)}</span> : null}</a>)}</nav>;

  const eh = (t: string) => <><span className="eh"><Flag {...I} />تصمیم‌گیری</span><b>{t}</b></>;
  // r1: «بررسی وضعیت امضا» opens the old panel inline under the contracts card; the resend button and notes column stay in place.
  const sigOpen = () => { setLgx(true); window.setTimeout(() => lgxRef.current?.querySelector('summary')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 60); };
  const lgxOpen = () => { setLgx(true); setTab('ov'); window.setTimeout(() => lgxRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60); };
  const missText = missing.map(docName).join(' و ');
  let nxa: ReactNode;
  if (closed) nxa = <section className="card nxa"><div className="t">{eh('پرونده بسته شده')}<span>{BUSINESS_STATUS_LABELS[biz as string] || 'این پرونده بسته شده است.'}</span></div></section>;
  else if (docStage && p.canUploadDocs && missing.length) nxa = <section className="card nxa"><div className="t">{eh('اقدام با شماست')}<span>{missText} مانده است.</span></div>
    <div className="a"><button className="btn pri sm" type="button" onClick={() => openUpload(missing[0])}><Upload {...I} />بارگذاری مدرک</button>
      <button className="btn sm" type="button" aria-disabled="true" aria-describedby="fdv1-sndw"><Send {...I} />ارسال به کارشناس ثبت</button><span className="why" id="fdv1-sndw">بعد از کامل شدن مدارک</span></div></section>;
  else if (docStage && p.canSubmitDocs && allUploaded) nxa = <section className="card nxa"><div className="t">{eh('اقدام با شماست')}<span>مدارک کامل است؛ پرونده را به کارشناس ثبت بفرست.</span></div>
    <div className="a"><button className="btn pri sm" type="button" onClick={() => { setWzNote(''); setWzErr(null); setModal({ k: 'wz', n: 1 }); }} data-testid="fdv1-send-open"><Send {...I} />ارسال به کارشناس ثبت</button></div></section>;
  else if (biz === 'waiting_customer_signature') nxa = <section className="card nxa"><div className="t">{eh('نوبت اقدام: مشتری')}<span>{currentCt?.title || 'قرارداد'} منتظر امضای مشتری است{currentCt?.rs?.firstSentAt ? `؛ از ${shortDay(currentCt.rs.firstSentAt)}` : ''}.</span></div>
    <div className="a"><button className="btn gh sm" type="button" onClick={() => go('contract')}><PenLine {...I} />وضعیت قرارداد</button></div></section>;
  else nxa = <section className={`card nxa${turn === 'me' ? '' : ' ok'}`}><div className="t">{eh(turn === 'me' ? 'اقدام با شماست' : turn ? `نوبت اقدام: ${turn}` : p.stageLabel)}<span>{p.stageLabel}</span></div>
    <div className="a"><button className={`btn ${turn === 'me' ? 'pri' : 'gh'} sm`} type="button" onClick={lgxOpen}><ChevronDown {...I} />کارهای این مرحله</button></div></section>;

  const money = (v: any) => <>{faAmount(v)} <small>تومان</small></>;
  const appr = app.approvedAmount;
  const apprAt = ((app.history || []) as any[]).filter(h => /initial-approv|funder-initial-approve|expert-approve|initial_approved/.test(String(h.action))).pop()?.created_at;
  const amount = <section className="card sec" aria-labelledby="fdv1-amt"><div className="sh"><h3 id="fdv1-amt"><Coins {...I} />اطلاعات پایه</h3></div><div className="kvg">
    <div className="kvc"><span className="k">مبلغ درخواستی</span><b className="v">{money(app.requestedAmount)}</b></div>
    <div className="kvc"><span className="k">مبلغ مصوب</span><b className="v">{appr ? money(appr) : <span className="muted">در انتظار تأیید</span>}</b>{appr && apprAt ? <span className="s">تصویب: {shortDay(apprAt)}</span> : null}</div>
    <div className="kvc"><span className="k">{appr ? 'تعداد اقساط مصوب' : 'تعداد اقساط درخواستی'}</span><b className="v">{app.durationMonths ? fd(app.durationMonths) : '—'} <small>ماه</small></b></div>
    {appr && app.netAmount ? <div className="kvc"><span className="k">مبلغ خالص (پس از کسورات)</span><b className="v">{money(app.netAmount)}</b></div> : null}</div>
    {appr && String(appr) !== String(app.requestedAmount) && !app.initialContractRetained ? <p className="dif"><CircleAlert {...I} />مبلغ مصوب با قرارداد اولیه فرق دارد؛ قرارداد جایگزین لازم است.</p> : null}</section>;

  const docUrl = (d: any, id = false) => `/api/loan-applications/${appId}/${id ? 'identity-documents' : 'documents'}/${d.id}/download?preview=1`;
  const docRow = (d: any, id: boolean) => {
    const s = id ? idSt(d) : docSt(d); const [c, Ic, t] = DST[s];
    const when = id ? (d.approvedAt ? `تأیید: ${shortDay(d.approvedAt)}` : '') : hasFile(d) && d.created_at ? shortDay(d.created_at) : '';
    const reason = !id && (s === 'bad' || s === 'rej') ? (d.incomplete_reason || d.reviewReason) : id && s === 'bad' ? d.reviewReason : '';
    const canUp = !id && !closed && p.canUploadDocs;
    const view = s !== 'miss' ? <a className="btn gh sm" href={docUrl(d, id)} target="_blank" rel="noopener noreferrer"><Eye {...I} />مشاهده</a> : null;
    const act = !id && canUp ? (s === 'miss' ? <button className="btn pri sm" type="button" onClick={() => openUpload(d)}><Upload {...I} />بارگذاری</button>
      : <>{view}<button className="btn lk sm" type="button" onClick={() => openUpload(d)}>{s === 'bad' || s === 'rej' ? 'بارگذاری مجدد' : 'جایگزینی'}</button></>) : view;
    return <li className="dr" key={`${id ? 'i' : 'd'}${d.id}`}><span className="fi">{id ? <IdCard {...I} /> : <FileText {...I} />}</span>
      <span className="tx"><b>{id ? (IDL[d.documentType] || 'مدرک هویتی') : docName(d)}</b>{closed && !id && s === 'miss' ? <DocMissingChip testId="fdv1-chip-missing" /> : closed && !id && s === 'wait' ? <span className="doc-missing-chip" data-testid="fdv1-chip-unreviewed">بررسی نشد</span> : <span className={`chip ${c}`}><Ic {...I} />{t}</span>}{when ? <small>{when}</small> : null}{reason ? <small>{reason}</small> : null}</span>
      {act ? <span className="ac">{act}</span> : null}</li>;
  };
  const done = custDocs.filter(d => docSt(d) !== 'miss').length + idDocs.filter(d => idSt(d) !== 'miss').length;
  const docsSummary = <section className="card sec" aria-labelledby="fdv1-dsm"><div className="sh"><h3 id="fdv1-dsm"><IdCard {...I} />مدارک</h3><span className="muted">{fd(done)} از {fd(custDocs.length + idDocs.length)} بارگذاری شده</span>
    <button className="btn lk sm" type="button" onClick={() => go('docs')}>همه‌ی مدارک</button></div><ul className="dl">{custDocs.map(d => docRow(d, false))}</ul></section>;
  const docsTab = <>{closed ? <p className="cls" role="status"><Lock {...I} />این پرونده بسته شده است و دیگر نمی‌شود مدرکی به آن اضافه کرد.</p> : null}
    <section className="card sec" aria-labelledby="fdv1-dfl"><div className="sh"><h3 id="fdv1-dfl"><IdCard {...I} />مدارک موردنیاز تسهیلات</h3>
      {!closed && p.canUploadDocs ? <button className="btn gh sm" type="button" onClick={lgxOpen}><Plus {...I} />درخواست مدرک جدید</button> : null}</div>
      <ul className="dl">{custDocs.map(d => docRow(d, false))}</ul></section>
    {idDocs.length ? <section className="card sec" aria-labelledby="fdv1-did"><div className="sh"><div className="sht"><h3 id="fdv1-did"><Shield {...I} />مدارک هویتی</h3><small className="shs">برای همه‌ی پرونده‌های این مشتری</small></div></div>
      <ul className="dl">{idDocs.map(d => docRow(d, true))}</ul></section> : null}</>;

  const resendBtn = (it: ResendItem, title: string) => {
    const left = leftFor(it);
    if (left > 0) return <button className="btn sm rsb" type="button" aria-disabled="true" aria-describedby={rsLine[it.generationId]?.kind === 'wait' ? 'fdv1-rsn' : undefined} data-left={left} data-testid="fdv1-resend-wait"><Clock {...I} /><span className="rsl">ارسال دوباره تا {leftText(left)}</span></button>;
    return <button className="btn pri sm rsb" type="button" onClick={() => setModal({ k: 'rs', item: it, title })} data-testid="fdv1-resend"><Send {...I} />ارسال دوباره‌ی لینک امضا</button>;
  };
  const ctChips = (c: (typeof contracts)[number]) => {
    if (c.old) return <span className="chip">نسخه‌ی پیشین، فقط برای دیدن سوابق</span>;
    if (c.rs) return <span className="chip g"><Clock {...I} />منتظر امضای مشتری در امضامی</span>;
    const d = c.doc; if (!d) return null;
    const rv = d.status === 'approved' ? ['s', 'بررسی: تأیید شده'] : d.status === 'incomplete' ? ['r', 'بررسی: نقص قرارداد'] : d.status === 'rejected' ? ['r', 'بررسی: رد شده'] : ['b', 'بررسی: در انتظار بررسی'];
    return <>{d.signed ? <span className="chip s"><Check {...I} />امضامی امضا را گزارش کرده است</span> : <span className="chip g"><Clock {...I} />منتظر امضای مشتری</span>}
      {d.signed ? <span className={`chip ${rv[0]}`}>{rv[0] === 'b' ? <Clock {...I} /> : null}{rv[1]}</span> : null}</>;
  };
  const ctRow = (c: (typeof contracts)[number]) => {
    const it = c.rs; const line = it ? rsLine[it.generationId] : undefined; const left = it ? leftFor(it) : 0;
    const meta = it ? <>{it.firstSentAt ? `فرستاده شد: ${shortDay(it.firstSentAt)}` : null}{it.lastSentAt ? <span className="rlast">آخرین ارسال لینک: <b>{whenShort(it.lastSentAt)}</b></span> : null}</>
      : c.doc?.signed && c.doc?.created_at ? `امضای مشتری: ${shortDay(c.doc.created_at)}` : c.doc?.created_at ? shortDay(c.doc.created_at) : '';
    const vUrl = c.doc?.downloadUrl && c.doc.fileAvailable !== false ? c.doc.downloadUrl : c.gen ? `/api/contracts/generations/${c.gen}/download/pdf?preview=1` : null;
    const view = vUrl ? <a className="btn gh sm" href={vUrl} target="_blank" rel="noopener noreferrer" data-testid="fdv1-ct-view"><Eye {...I} />مشاهده</a> : null;
    return <li className={`ct${c.old ? ' old' : ''}`} key={c.key} data-testid={`fdv1-ct-${c.gen}`}><span className="fi"><PenLine {...I} /></span>
      <span className="tx"><b>{c.title}</b><span className="chs">{ctChips(c)}</span><small>{meta}</small></span>
      {/* r3 §8 (Mohammad): no CRM-side resend; «بررسی وضعیت امضا» is the primary action while waiting for the customer's signature */}
      <span className="ac">{view}{!closed && !c.old ? <button className={`btn sm ${c.rs || !c.doc?.signed ? 'pri' : 'lk'}`} type="button" onClick={sigOpen} data-testid="fdv1-sigcheck"><RefreshCw {...I} />بررسی وضعیت امضا</button> : null}</span>
      {!closed && !c.old && (c.rs || (c.doc && !c.doc.signed)) ? <p className="rsn sgn" data-testid="fdv1-sign-hint"><Send {...I} /><span>لینک امضا را امضامی برای مشتری فرستاده است. اگر به دستش نرسیده، «بررسی وضعیت امضا» را بزن.</span></p> : null}
      {it && line?.kind === 'turn' ? <div className="ferr box rse" role="alert"><CircleAlert {...I} /><div><span>{line.name ? <>کارهای پرونده‌ها به ترتیب نوبت انجام می‌شود؛ اول پرونده‌ی <b>{line.name}</b> را کامل کن.</> : 'کارهای پرونده‌ها به ترتیب نوبت انجام می‌شود؛ اول پرونده‌ی نوبت را کامل کن.'}</span>
        {line.fileId ? <div className="fa2"><button className="btn gh sm" type="button" onClick={() => navigate(`/loan-applications/${line.fileId}`)}><ArrowLeft {...I} />رفتن به پرونده‌ی {line.name ?? fd(line.fileId)}</button></div> : null}</div></div> : null}
    </li>;
  };
  const contractTab = <section className="card sec" aria-labelledby="fdv1-ctt"><div className="sh"><h3 id="fdv1-ctt"><PenLine {...I} />قراردادها</h3>{contracts.length ? <span className="muted">نوع: قرارداد اصلی</span> : null}</div>
    {contracts.length ? <ul className="dl">{contracts.map(ctRow)}</ul> : <p className="hist-empty">هنوز قراردادی برای این پرونده ساخته نشده است.</p>}</section>;
  const contractSummary = <section className="card sec" aria-labelledby="fdv1-cts"><div className="sh"><h3 id="fdv1-cts"><PenLine {...I} />قراردادها</h3><button className="btn lk sm" type="button" onClick={() => go('contract')}>جزئیات</button></div>
    <p className="one">{currentCt ? <>{currentCt.title}: {currentCt.rs ? <span className="chip g">منتظر امضای مشتری</span> : currentCt.doc?.signed
      ? <><span className="chip s">امضا شده</span>{currentCt.doc.status === 'approved' ? <span className="chip s">تأیید شده</span> : currentCt.doc.status === 'incomplete' || currentCt.doc.status === 'rejected' ? <span className="chip r">{currentCt.doc.status === 'rejected' ? 'رد شده' : 'نقص'}</span> : <span className="chip b">در انتظار بررسی</span>}</>
      : <span className="chip g">منتظر امضای مشتری</span>}</> : 'هنوز قراردادی ساخته نشده است.'}</p></section>;

  const hItem = (e: HistoryEvent) => { const Ic = histIcon(e.action);
    return <li key={e.id}><span className="ic"><Ic {...I} /></span><b className="tl">{histLabel(e.action)}</b><span className="by">{e.author?.name || 'سامانه'}</span><span className="tm">{hm(e.createdAt)}</span></li>; };
  const shown = hist.filter(e => hCat === 'all' || histCat(e.action) === hCat);
  const days: [string, HistoryEvent[]][] = [];
  for (const e of shown) { const k = dayKey(e.createdAt); const last = days[days.length - 1]; if (last && last[0] === k) last[1].push(e); else days.push([k, [e]]); }
  const historyTab = <section className="card sec" aria-labelledby="fdv1-hst"><div className="sh"><h3 id="fdv1-hst"><HistoryIcon {...I} />تاریخچه‌ی پرونده</h3>
    <div className="seg" role="tablist" aria-label="نوع رویداد">{([['all', 'همه'], ['step', 'مراحل'], ['doc', 'مدارک'], ['ct', 'قرارداد']] as [HCat, string][]).map(([k, t]) =>
      <button key={k} type="button" role="tab" aria-selected={hCat === k} onClick={() => setHCat(k)}>{t}</button>)}</div></div>
    {hState === 'loading' ? <p className="hist-empty" role="status">در حال دریافت تاریخچه…</p> : hState === 'error' ? <p className="ferr" role="alert"><CircleAlert {...I} />تاریخچه دریافت نشد. <button className="btn lk sm" type="button" onClick={() => void loadHist(null)}>دوباره امتحان کن</button></p>
      : !shown.length ? <p className="hist-empty">رویدادی در این دسته نیست.</p>
      : days.map(([k, it]) => <React.Fragment key={k}><h4 className="hday">{dayLabel(it[0].createdAt)}</h4><ul className="ftl">{it.map(hItem)}</ul></React.Fragment>)}
    {hState === 'ok' && hCursor ? <button className="btn lk sm more" type="button" onClick={() => void loadHist(hCursor)}>موارد قدیمی‌تر</button> : null}</section>;
  const historySummary = <section className="card sec" aria-labelledby="fdv1-hsm"><div className="sh"><h3 id="fdv1-hsm"><HistoryIcon {...I} />تاریخچه‌ی پرونده</h3><button className="btn lk sm" type="button" onClick={() => go('hist')}>همه</button></div>
    <ul className="ftl">{hist.slice(0, 3).map(hItem)}</ul></section>;

  const legacyBlock = <details className="card sec lgx" ref={lgxRef} open={lgx} onToggle={e => setLgx((e.currentTarget as HTMLDetailsElement).open)} data-testid="fdv1-legacy">
    <summary><ChevronDown {...I} />جزئیات و کارهای بیشتر این مرحله</summary>{lgx ? <div className="lgb">{p.legacy}</div> : null}</details>;

  let body: ReactNode = null;
  if (tab === 'ov' || tab === 'chat') body = <>{nxa}<div className="g2">{amount}{hasDocs ? docsSummary : null}{contractSummary}{historySummary}</div>{legacyBlock}</>;
  if (tab === 'docs') body = docsTab;
  if (tab === 'contract') body = <>{contractTab}{legacyBlock}</>;
  if (tab === 'hist') body = historyTab;

  // ---------- modals ----------
  let md: ReactNode = null;
  if (modal?.k === 'up') {
    const d = modal.doc; const label = docName(d);
    const choose = () => pick.current?.click();
    const doUpload = () => { if (!upFile || upErr || upload.isPending) return; upload.mutate({ id: appId, data: { file: upFile, label: d.label || label, requirementKey: d.requirement_key || d.requirementKey } as any }); };
    md = <ModalShell cls="up" title={`بارگذاری ${label}`} sub={`پرونده‌ی ${fd(app.id)}، ${custName}`} onClose={() => setModal(null)} diag={openDiag}
      foot={<><button className="btn pri" type="button" onClick={doUpload} aria-disabled={!upFile || !!upErr || upload.isPending} aria-describedby={upErr ? 'fdv1-uperr' : undefined} aria-busy={upload.isPending} data-testid="fdv1-upload-go"><Upload {...I} />{upload.isPending ? 'در حال بارگذاری…' : 'بارگذاری'}</button>
        <button className="btn gh" type="button" onClick={() => setModal(null)}>انصراف</button></>}>
      <div className="fld"><div className="flab"><label htmlFor="fdv1-upf">فایل مدرک</label></div>
        <input ref={pick} className="upin" type="file" tabIndex={-1} aria-hidden="true" data-testid="fdv1-upload-input" onChange={e => { const f = e.target.files?.[0] || null; e.target.value = ''; if (!f) return; setUpFile(f); setUpErr(docClientCheck(f)); }} />
        <div className={`upf${upErr ? ' err' : ''}`}><span className="fi"><FileIcon {...I} /></span>
          <span className="tx">{upFile ? <><b dir="ltr">{upFile.name}</b><span>{sizeFa(upFile.size)}</span></> : <><b>فایلی انتخاب نشده</b><span>از گوشی یا رایانه انتخاب کن</span></>}</span>
          <button className="btn lk sm" type="button" id="fdv1-upf" onClick={choose}>{upFile ? 'عوض کردن فایل' : 'انتخاب فایل'}</button></div>
        {upErr ? <UpErrBox err={upErr} onPick={choose} onRetry={() => { setUpErr(null); window.setTimeout(doUpload, 0); }} onGo={id => { setModal(null); navigate(`/loan-applications/${id}`); }} />
          : <p className="hint">{DOC_UPLOAD_TYPES ? `${DOC_UPLOAD_TYPES.label}، ` : 'هر نوع فایلی، '}تا {fd(Math.round(DOC_UPLOAD_MAX_BYTES / 1048576))} مگابایت</p>}</div>
    </ModalShell>;
  }
  if (modal?.k === 'wz') {
    const n = modal.n; const count = custDocs.length + idDocs.length;
    const submit = () => {
      if (p.submitDocs.isPending) return; setWzErr(null);
      p.submitDocs.mutate({ id: appId }, {
        onSuccess: () => {
          const note = wzNote.trim();
          if (note) void postNote(appId, crypto.randomUUID(), note, null).catch(() => show('پرونده فرستاده شد، ولی یادداشت ثبت نشد؛ در یادداشت‌ها دوباره بنویس.'));
          setModal(null); show('پرونده به کارشناس ثبت فرستاده شد.'); void loadHist(null);
        },
        onError: e => setWzErr(docServerError(e)),
      });
    };
    md = <ModalShell cls="wz" title="ارسال به کارشناس ثبت" sub={`مرحله‌ی ${fd(n)} از ۲، پرونده‌ی ${fd(app.id)}`} top={<WzSteps n={n} />} onClose={() => setModal(null)}
      foot={n === 1 ? <><button className="btn pri" type="button" onClick={() => setModal({ k: 'wz', n: 2 })}>بعدی<ChevronLeft {...I} /></button><button className="btn gh" type="button" onClick={() => setModal(null)}>انصراف</button></>
        : <><button className="btn pri" type="button" onClick={submit} aria-busy={p.submitDocs.isPending} data-testid="fdv1-send-go"><Send {...I} />{p.submitDocs.isPending ? 'در حال ارسال…' : 'ارسال به کارشناس ثبت'}</button>
          <button className="btn gh" type="button" onClick={() => setModal({ k: 'wz', n: 1 })}><ChevronRight {...I} />قبلی</button></>}>
      {n === 1 ? <ul className="dl rv">{[...custDocs.map(docName), ...(idDocs.length ? [`مدارک هویتی سراسری (${fd(idDocs.length)} مدرک)`] : [])].map((t, i) =>
        <li className="dr" key={i}><span className="fi ok"><Check {...I} /></span><span className="tx"><b>{t}</b></span></li>)}</ul>
        : <><div className="rvw"><div className="r"><span className="k">به</span><span className="v">کارشناس ثبت</span></div><div className="r"><span className="k">مدارک</span><span className="v">{fd(count)} مدرک</span></div></div>
          <div className="fld"><div className="flab"><label htmlFor="fdv1-sm">یادداشت برای کارشناس ثبت</label><span className="cn">اختیاری</span></div>
            <textarea id="fdv1-sm" className="ta2" rows={3} value={wzNote} onChange={e => setWzNote(e.target.value)} /></div>
          {wzErr ? wzErr.kind === 'turn' ? <UpErrBox err={wzErr} onPick={() => undefined} onRetry={submit} onGo={id => { setModal(null); navigate(`/loan-applications/${id}`); }} />
            : <div className="ferr box" role="alert"><CircleAlert {...I} /><div><span>{wzErr.kind === 'network' ? 'اتصال برقرار نشد و پرونده فرستاده نشد. اینترنت را بررسی کن و دوباره امتحان کن.' : 'پرونده فرستاده نشد. یک بار دیگر امتحان کن؛ اگر باز هم نشد، «گزارش خطا» را بزن.'}</span></div></div> : null}</>}
    </ModalShell>;
  }
  if (modal?.k === 'rs') {
    const it = modal.item;
    md = <ModalShell cls="cf sg" title="ارسال دوباره‌ی لینک امضا" sub={`${modal.title}، پرونده‌ی ${fd(app.id)}، ${custName}`} onClose={() => setModal(null)}
      foot={<><button className="btn pri" type="button" onClick={() => void doResend(it)} aria-busy={sending} data-testid="fdv1-resend-go"><Send {...I} />{sending ? 'در حال ارسال…' : 'بفرست'}</button><button className="btn gh" type="button" onClick={() => setModal(null)}>انصراف</button></>}>
      <p className="sgb">لینک امضا دوباره با پیامک به شماره‌ی {phone ? <bdi className="phn" dir="ltr">{fd(phone)}</bdi> : 'مشتری'} فرستاده می‌شود.</p>
      {it.lastSentAt ? <p className="sgl"><Clock {...I} />آخرین ارسال: {whenShort(it.lastSentAt)}</p> : null}
    </ModalShell>;
  }

  return <div className="fdv1" data-testid="file-detail-v1">
    <main className="pg fpg" {...(md ? { inert: '' as any, 'aria-hidden': true } : {})}><div className="fgrid">
      <div className="fmain">{head}{tabs}<div className="tabp">{body}</div></div>
      <NotesColumn appId={appId} user={user} onBack={() => setTab('ov')} title={`پرونده‌ی ${fd(app.id)}، ${custName}`} sys={sysLines} />
    </div></main>
    {md}
    <div className={`toast${toast ? ' on' : ''}`} role="status" aria-live="polite">{toast ? <><Check {...I} /><span>{toast}</span></> : null}</div>
  </div>;
}
