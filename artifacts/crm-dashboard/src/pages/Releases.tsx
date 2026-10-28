import { useEffect, useMemo, useRef, useState, type KeyboardEvent as RKeyboardEvent, type ReactNode } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowLeft, Check, Copy, Database, Eye, GitBranch, GitCommitHorizontal, Globe, Info, Lock, RefreshCw, RotateCcw, Server, X } from 'lucide-react';
import { mapOperation, releaseGate, paginate, ridToTehran, crmRefetchMs, type OperationView } from '@/lib/releases-model';
import './releases.css';

// Release 84(A): «نسخه‌های سایت و CRM» (Armita site-versions v1.0 + PM answers 1–7), admin-only route.
//  * Site tab: read-only registry (GET /api/site-releases). No rollback here; a dashed «برگشت: فاز بعد» slot
//    marks where it will go. Rollback stays manual by the developer (path text per row).
//  * CRM tab: the installed release manager (GET /api/releases, POST /api/releases/activate, unchanged)
//    plus metadata (GET /api/crm-release-meta). Only rollback is offered (PM #4: no deploy-newer here); older
//    than the last schema change = disabled with the reason. Confirm requires typing the target RID (PM #1).

type Tab = 'site' | 'crm';
type Release = { id: string; version: string; active: boolean; ready: boolean; source: 'installed' | 'uploaded' };
type Operation = { target?: string; status?: string; error?: string; updatedAt?: string };
type ReleasesResponse = { available: boolean; reason?: string; current: string | null; latest: string | null; updatesAvailable: boolean; releases: Release[]; operation?: Operation | null };
type CrmMetaEntry = { commit: string | null; branch: string | null; description: string | null; schemaChange: string | null; releaseNo?: string | null };
type CrmMeta = { available: boolean; reason?: string; schemaCutoff: string | null; cutoffSource?: string; releases: Record<string, CrmMetaEntry> };
type SiteRelease = { rid: string; commit: string | null; branch: string | null; description: string | null; rollback: string | null; notes: string | null; releaseNo?: string | null; tehran: string | null; current: boolean; onDisk: boolean | null };
type SiteResponse = { available: boolean; reason?: string; current?: string | null; releases?: SiteRelease[]; invalidRows?: number };

const SITE_STEP = 10;
const CRM_PER = 8;
const fa = (v: string | number) => String(v).replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[Number(d)]);
// Compact pager: first, last, current ±1; 0 marks a gap («…»).
const pageWindow = (page: number, pages: number): number[] => {
  const keep = new Set([1, pages, page - 1, page, page + 1].filter((n) => n >= 1 && n <= pages));
  const out: number[] = []; let prev = 0;
  for (const n of [...keep].sort((a, b) => a - b)) { if (n - prev > 1) out.push(n - prev === 2 ? n - 1 : 0); out.push(n); prev = n; }
  return out;
};
const crmNo = (no?: string | null) => (no ? `انتشار ${fa(no)}` : null);
const siteNo = (no?: string | null) => (no ? `انتشار سایت ${fa(no)}` : null);

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: 'include' });
  if (res.status === 401 || res.status === 403) throw new Error('شما دسترسی لازم برای مشاهده این بخش را ندارید.');
  if (!res.ok) throw new Error('خطا در دریافت وضعیت نسخه‌ها. لطفاً دوباره تلاش کنید.');
  return res.json();
}

/** 7 characters shown; the button copies exactly what the registry stores (the full SHA when recorded). */
function Sha({ sha }: { sha: string | null }) {
  const [did, setDid] = useState(false);
  if (!sha) return <span className="hint">ثبت نشده</span>;
  const copy = async () => {
    try { await navigator.clipboard.writeText(sha); setDid(true); window.setTimeout(() => setDid(false), 1800); } catch { /* clipboard blocked */ }
  };
  return (
    <button type="button" className={`sha${did ? ' did' : ''}`} onClick={copy} aria-label={`کامیت ${sha.slice(0, 7)}، برای کپی بزن`} title={sha} data-testid="sha-copy">
      <GitCommitHorizontal className="i" aria-hidden />
      <bdi dir="ltr" className="mono">{sha.slice(0, 7)}</bdi>
      <Copy className="i cpi" aria-hidden />
      <span className="cpd" aria-live="polite">{did ? 'کپی شد' : ''}</span>
    </button>
  );
}

function Branch({ name }: { name: string | null }) {
  if (!name) return <span className="hint">ثبت نشده</span>;
  return <span className="brn"><GitBranch className="i" aria-hidden /><bdi dir="ltr" className="mono" title={name}>{name}</bdi></span>;
}

const CurBadge = () => <span className="svtg cur"><Check className="i" aria-hidden />نسخه‌ی فعلی</span>;
const Msg = ({ text }: { text: string | null | undefined }) => (text ? <>{text}</> : <span className="nomsg">توضیح ثبت نشده</span>);

function When({ rid, inline }: { rid: string; inline?: boolean }) {
  const t = ridToTehran(rid);
  if (!t) return <span className="hint">زمان نامعلوم</span>;
  if (inline) return <span className="tw">{t.date}، ساعت {t.time} <small>به وقت تهران</small></span>;
  return <><b className="dt">{t.date}</b><span className="tm">ساعت {t.time}</span></>;
}

/** Version cell: number when known (never invented, PM #3/#7), else «—»; the RID is always visible. */
function VersionLabel({ no, rid }: { no: string | null; rid: string }) {
  return <><b>{no ?? '—'}</b><bdi dir="ltr" className="mono rid">{rid}</bdi></>;
}

function Banner({ tone, icon, title, children, role = 'note', id, extra }: { tone: string; icon: ReactNode; title: ReactNode; children?: ReactNode; role?: string; id?: string; extra?: ReactNode }) {
  return (
    <div className={`ban ${tone}`} role={role} id={id} data-testid={`ban-${tone}`}>
      {icon}
      <div><b>{title}</b>{children ? <p>{children}</p> : null}{extra}</div>
    </div>
  );
}

function Loading({ what }: { what: string }) {
  return (
    <div className="svl" aria-busy="true" data-testid="sv-loading">
      <p className="ldt"><span className="spn" aria-hidden />در حال خواندن {what}…</p>
      <span className="sk cpi" /><span className="sk w4" /><span className="sk w3" /><span className="sk cpi" /><span className="sk w4" /><span className="sk w2" />
    </div>
  );
}

function Empty({ title, text, icon }: { title: string; text: string; icon: ReactNode }) {
  return <div className="svl"><div className="emp" data-testid="sv-empty">{icon}<b>{title}</b><p>{text}</p></div></div>;
}

function LoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <Banner tone="bad" role="alert" icon={<AlertTriangle className="i" aria-hidden />} title="فهرست نسخه‌ها خوانده نشد" extra={<div className="bb"><button type="button" className="btn sm" onClick={onRetry}><RefreshCw className="i" aria-hidden />دوباره امتحان کن</button></div>}>
      {message}
    </Banner>
  );
}

function CurrentCard({ where, label, rid, no, commit, branch, desc, extra }: { where: string; label: string; rid: string; no: string | null; commit: string | null; branch: string | null; desc: string | null; extra?: ReactNode }) {
  return (
    <section className="svcur" aria-label={`نسخه‌ی فعلی ${where}`} data-testid="sv-current">
      <div className="h"><Server className="i" aria-hidden /><span>{label}</span><CurBadge /></div>
      <div className="b"><b className="big">{no ?? <bdi dir="ltr" className="mono">{rid}</bdi>}</b>{no ? <bdi dir="ltr" className="mono hint">{rid}</bdi> : null}{extra}<When rid={rid} inline /></div>
      <p className="msg"><Msg text={desc} /></p>
      <div className="r2"><Sha sha={commit} /><Branch name={branch} /></div>
    </section>
  );
}

function SiteRollbackText({ text }: { text: string | null }) {
  if (!text) return null;
  return <details className="rbk"><summary>مسیر برگشت دستی (فقط توسعه‌دهنده)</summary><code>{text}</code></details>;
}

function SiteTab() {
  const [shown, setShown] = useState(SITE_STEP);
  const q = useQuery<SiteResponse, Error>({ queryKey: ['site-releases'], queryFn: () => getJson<SiteResponse>('/api/site-releases'), staleTime: 60_000 });
  const info = (
    <Banner tone="info" icon={<Eye className="i" aria-hidden />} title="فعلاً فقط مشاهده">
      برگشت سایت در فاز بعد اضافه می‌شود و تا آن موقع دستی و به دست توسعه‌دهنده انجام می‌شود. جای دکمه‌ی آن در هر ردیف با کادر خط‌چین «فاز بعد» مشخص است. برگشت CRM در تب «نسخه‌های CRM» است.
    </Banner>
  );
  if (q.isLoading) return <>{info}<Loading what="نسخه‌های سایت" /></>;
  if (q.isError) return <>{info}<LoadError message={q.error.message} onRetry={() => q.refetch()} /></>;
  const d = q.data;
  if (!d?.available) return <>{info}<Empty icon={<Globe className="i" aria-hidden />} title="فهرست نسخه‌های سایت در دسترس نیست" text={`فایل ثبت نسخه‌های سایت روی سرور خوانده نشد (${d?.reason ?? 'نامشخص'}). به توسعه‌دهنده خبر بده.`} /></>;
  const all = d.releases ?? [];
  if (all.length === 0) return <>{info}<Empty icon={<Globe className="i" aria-hidden />} title="هنوز نسخه‌ای ثبت نشده" text="بعد از اولین انتشار سایت، نسخه‌ها این‌جا با زمان، کامیت و توضیح دیده می‌شوند." /></>;
  const cur = all.find((r) => r.current) ?? null;
  const rows = all.slice(0, shown);
  const left = all.length - rows.length;
  const act = (r: SiteRelease) => (r.current
    ? <span className="hint nocur">الان روی سایت</span>
    : <span className="slot" title="جای دکمه‌ی «برگشت به این نسخه»؛ فاز بعد">برگشت: فاز بعد</span>);
  return (
    <>
      {cur ? <CurrentCard where="سایت" label="الان روی سایت nafisvam.com" rid={cur.rid} no={siteNo(cur.releaseNo)} commit={cur.commit} branch={cur.branch} desc={cur.description} /> : null}
      {info}
      <div className="svl" data-testid="site-release-list">
        <table className="svt">
          <caption className="sr">فهرست نسخه‌های سایت، جدیدترین بالا</caption>
          <thead><tr><th scope="col">زمان <small>به وقت تهران</small></th><th scope="col">نسخه</th><th scope="col">کامیت</th><th scope="col">شاخه</th><th scope="col">توضیح</th><th scope="col"><span className="sr">کار</span></th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.rid} className={r.current ? 'iscur' : ''} data-testid={`site-release-${r.rid}`}>
                <td><When rid={r.rid} /></td>
                <td><div className="rl"><VersionLabel no={siteNo(r.releaseNo)} rid={r.rid} />{r.current ? <CurBadge /> : null}</div>{r.onDisk === false ? <div className="tgs"><span className="svtg bad">روی سرور نیست</span></div> : null}</td>
                <td><Sha sha={r.commit} /></td>
                <td><Branch name={r.branch} /></td>
                <td className="ms"><span><Msg text={r.description} /></span>{r.notes ? <small>{r.notes}</small> : null}<SiteRollbackText text={r.current ? null : r.rollback} /></td>
                <td className="ac"><div className="acw">{act(r)}</div></td>
              </tr>
            ))}
          </tbody>
        </table>
        <ul className="svcs">
          {rows.map((r) => (
            <li key={r.rid} className={`svc${r.current ? ' iscur' : ''}`} data-testid={`site-card-${r.rid}`}>
              <div className="r1"><b>{siteNo(r.releaseNo) ?? '—'}</b><bdi dir="ltr" className="mono hint">{r.rid}</bdi>{r.current ? <CurBadge /> : null}</div>
              <p className="tw"><When rid={r.rid} inline /></p>
              <p className="msg"><Msg text={r.description} /></p>
              <div className="r2"><Sha sha={r.commit} /><Branch name={r.branch} /></div>
              <SiteRollbackText text={r.current ? null : r.rollback} />
              <div className="ca">{act(r)}</div>
            </li>
          ))}
        </ul>
        <div className="svf">
          <span className="hint">{fa(rows.length)} از {fa(all.length)} نسخه</span>
          {left > 0
            ? <button type="button" className="btn sm" onClick={() => setShown((n) => n + SITE_STEP)} data-testid="site-more">نمایش {fa(Math.min(left, SITE_STEP))} نسخه‌ی قدیمی‌تر</button>
            : <span className="hint" data-testid="site-end">به اولین نسخه رسیدی.</span>}
        </div>
      </div>
    </>
  );
}

type Side = { no: string | null; rid: string; desc: string | null; commit: string | null };

/**
 * CRM rollback confirm (Armita c_confirm + PM #1): focus starts on «انصراف», Tab is trapped, Esc closes and
 * the caller returns focus to the row button. The red button stays off until the exact target RID is typed.
 */
function ConfirmDialog({ from, to, pending, error, onCancel, onConfirm }: { from: Side; to: Side; pending: boolean; error: string; onCancel: () => void; onConfirm: () => void }) {
  const [typed, setTyped] = useState('');
  const box = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { cancelRef.current?.focus(); }, []);
  const ok = typed.trim() === to.rid;
  const toName = to.no ?? 'این نسخه';
  const onKey = (e: RKeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') { e.preventDefault(); if (!pending) onCancel(); return; }
    if (e.key !== 'Tab' || !box.current) return;
    const f = Array.from(box.current.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),summary,[tabindex]:not([tabindex="-1"])'));
    if (f.length === 0) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  const sideBox = (s: Side, cls: string, lab: string) => (
    <div className={`fb ${cls}`}>
      <span className="lab">{lab}</span>
      <b>{s.no ?? <bdi dir="ltr" className="mono">{s.rid}</bdi>}</b>
      {s.no ? <bdi dir="ltr" className="mono hint">{s.rid}</bdi> : null}
      <When rid={s.rid} inline />
      <p className="msg"><Msg text={s.desc} /></p>
      {s.commit ? <span className="hint">کامیت <bdi dir="ltr" className="mono">{s.commit.slice(0, 7)}</bdi></span> : null}
    </div>
  );
  return (
    <div className="sv84-ov" onKeyDown={onKey}>
      <div className="rmd wide" role="dialog" aria-modal="true" aria-labelledby="sv84-dlg-t" ref={box} data-testid="release-activation-modal">
        <div className="rmh">
          <span className="eyb">تغییر نسخه‌ی CRM (سایت دست نمی‌خورد)</span>
          <h2 id="sv84-dlg-t">برگشت CRM به {toName}؟</h2>
        </div>
        <div className="rmb">
          <div className="ft">
            {sideBox(from, 'from', 'الان روی CRM (نسخه‌ی فعلی)')}
            <span className="arr" aria-hidden><ArrowLeft className="i" /></span>
            {sideBox(to, 'to', 'بعد از برگشت')}
          </div>
          <div className="cq">
            <b><AlertTriangle className="i" aria-hidden />بعد از تأیید چه می‌شود</b>
            <ul>
              <li>فقط CRM عوض می‌شود؛ سایت nafisvam.com دست نمی‌خورد.</li>
              <li>CRM حدود ۳۰ ثانیه دوباره راه‌اندازی می‌شود؛ فرم‌های ذخیره‌نشده‌ی همکاران از دست می‌رود.</li>
              <li>تغییرهای {from.no ?? 'نسخه‌ی فعلی'} از CRM برداشته می‌شود.</li>
              <li>اول از پایگاه داده پشتیبان گرفته می‌شود؛ هیچ داده‌ای پاک نمی‌شود و ساختار پایگاه داده همان می‌ماند.</li>
              <li>نتیجه (موفق، برگشت خودکار یا خطا) بالای همین تب نشان داده می‌شود.</li>
            </ul>
          </div>
          <div className="typ">
            <label htmlFor="sv84-typed">برای تأیید، شناسه‌ی نسخه‌ی مقصد را دقیق بنویس: <bdi dir="ltr" className="mono">{to.rid}</bdi></label>
            <input id="sv84-typed" dir="ltr" className="mono" inputMode="numeric" autoComplete="off" value={typed} onChange={(e) => setTyped(e.target.value)} aria-describedby={error ? 'sv84-dlg-err' : undefined} data-testid="confirm-rid" />
          </div>
          {error ? <p className="ferr" id="sv84-dlg-err" role="alert">{error}</p> : null}
        </div>
        <div className="rmf">
          <button type="button" className="btn" ref={cancelRef} onClick={onCancel} disabled={pending} data-testid="confirm-cancel">انصراف</button>
          <button type="button" className="btn dz" onClick={() => { if (ok && !pending) onConfirm(); }} disabled={!ok || pending} data-testid="confirm-go">
            <RotateCcw className="i" aria-hidden />{pending ? 'در حال فرستادن…' : `بله، برگرد به ${toName}`}
          </button>
        </div>
      </div>
    </div>
  );
}

function CrmTab() {
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Release | null>(null);
  const [activationError, setActivationError] = useState('');
  const [mine, setMine] = useState<string | null>(null); // target this browser asked for (progress vs «busy»)
  const [hideResult, setHideResult] = useState<string>('');
  const returnFocus = useRef<string | null>(null);

  const releasesQuery = useQuery<ReleasesResponse, Error>({
    queryKey: ['releases'],
    queryFn: () => getJson<ReleasesResponse>('/api/releases'),
    refetchInterval: (query) => crmRefetchMs(mapOperation(query.state.data?.operation).kind),
    refetchIntervalInBackground: false,
  });
  const metaQuery = useQuery<CrmMeta, Error>({ queryKey: ['crm-release-meta'], queryFn: () => getJson<CrmMeta>('/api/crm-release-meta'), staleTime: 5 * 60_000 });

  const activateMutation = useMutation<void, Error, { id: string }>({
    mutationFn: async ({ id }) => {
      const res = await fetch('/api/releases/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ id }),
      });
      if (!res.ok && res.status !== 202) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error || 'خطا در اعمال نسخه. لطفاً لاگ‌های سیستم را بررسی کنید.');
      }
    },
    onSuccess: (_d, vars) => {
      setActivationError('');
      setMine(vars.id);
      setHideResult('');
      setSelected(null);
      queryClient.invalidateQueries({ queryKey: ['releases'] });
    },
    onError: (err) => {
      setActivationError(err.message);
    }
  });

  const data = releasesQuery.data;
  const meta = metaQuery.data;
  const cutoff = meta?.available ? meta.schemaCutoff : null;
  const op = mapOperation(data?.operation);
  const opTarget = data?.operation?.target ?? null;
  const opKey = `${data?.operation?.status ?? ''}|${opTarget ?? ''}|${data?.operation?.updatedAt ?? ''}`;
  const sorted = useMemo(() => [...(data?.releases ?? [])].sort((a, b) => b.version.localeCompare(a.version) || b.id.localeCompare(a.id)), [data?.releases]);
  const metaFor = (id: string | null | undefined, version?: string) => (id ? meta?.releases?.[id] ?? (version ? meta?.releases?.[version] : undefined) ?? null : null);
  const nameOf = (id: string | null | undefined) => { const m = metaFor(id); return crmNo(m?.releaseNo) ?? (id ? `نسخه‌ی ${id}` : 'نسخه‌ی نامعلوم'); };
  const cutoffLabel = cutoff ? (crmNo(metaFor(cutoff)?.releaseNo) ?? `نسخه‌ی ${cutoff}`) : '';
  const busy = op.blocksActions || activateMutation.isPending;
  const gateFor = (r: Release) => releaseGate({ version: r.version, current: data?.current ?? null, cutoff, cutoffLabel, ready: r.ready, busy });
  const isTarget = (r: Release) => !!opTarget && (opTarget === r.id || opTarget === r.version);

  const open = (r: Release, from?: string) => { returnFocus.current = from ?? null; setActivationError(''); setSelected(r); };
  const close = () => {
    setSelected(null); setActivationError('');
    const id = returnFocus.current; if (id) window.setTimeout(() => document.getElementById(id)?.focus(), 0);
  };
  const confirm = () => {
    if (!selected) return;
    if (!gateFor(selected).allowed) { setActivationError('این برگشت الان مجاز نیست.'); return; }
    activateMutation.mutate({ id: selected.id });
  };

  if (releasesQuery.isLoading) return <Loading what="نسخه‌های CRM" />;
  if (releasesQuery.isError) return <LoadError message={releasesQuery.error.message} onRetry={() => releasesQuery.refetch()} />;
  if (!data || !data.available) {
    return <Empty icon={<Server className="i" aria-hidden />} title="مدیریت نسخه‌ی CRM فعال نیست" text={data?.reason || 'این بخش فقط روی سرور اصلی و با سرویس جداگانه‌ی انتشار کار می‌کند.'} />;
  }
  if (sorted.length === 0) return <Empty icon={<Server className="i" aria-hidden />} title="هیچ نسخه‌ای پیدا نشد" text="سرویس انتشار هیچ نسخه‌ی نصب‌شده‌ای گزارش نکرد." />;

  const pg = paginate(sorted, page, CRM_PER);
  const curRel = sorted.find((r) => r.version === data.current) ?? null;
  const curMeta = curRel ? metaFor(curRel.id, curRel.version) : null;
  const selMeta = selected ? metaFor(selected.id, selected.version) : null;

  const status = (r: Release) => {
    const t = isTarget(r);
    if (t && op.kind === 'running') return <span className="svtg run"><i className="spn" aria-hidden />در حال اجرا</span>;
    if (r.version === data.current) return <span className="svtg act">فعال</span>;
    if (t && op.kind === 'auto_rollback') return <span className="svtg arb"><RotateCcw className="i" aria-hidden />برگشت خودکار</span>;
    if (t && (op.kind === 'failed' || op.kind === 'manual_recovery')) return <span className="svtg bad"><AlertTriangle className="i" aria-hidden />خطا</span>;
    if (!r.ready) return <span className="svtg bad">ناقص</span>;
    return <span className="svtg okk">آماده</span>;
  };
  const note = (r: Release) => {
    if (!isTarget(r)) return null;
    if (op.kind === 'manual_recovery' || op.kind === 'failed') return <p className="errn"><Info className="i" aria-hidden /><span><b>نیاز به کار دستی:</b> {op.message}</span></p>;
    if (op.kind === 'auto_rollback') return <p className="errn"><Info className="i" aria-hidden /><span>{op.message}</span></p>;
    return null;
  };
  const action = (r: Release, at: 't' | 'c') => {
    if (r.version === data.current) return <span className="hint nocur">الان روی CRM</span>;
    const g = gateFor(r);
    if (g.action === 'none') return <span className="why">{g.reason}</span>;
    if (!r.ready || (isTarget(r) && (op.kind === 'failed' || op.kind === 'manual_recovery'))) return <span className="hint">قابل برگشت نیست</span>;
    if (g.allowed) {
      return <button type="button" id={`sv84-rb-${at}${r.id}`} className="btn sm rbb" onClick={() => open(r, `sv84-rb-${at}${r.id}`)} data-testid={`crm-rollback-${at}-${r.id}`}><RotateCcw className="i" aria-hidden />برگشت به این نسخه</button>;
    }
    const locked = !!cutoff && r.version < cutoff;
    return (
      <>
        <button type="button" id={`sv84-rb-${at}${r.id}`} className="btn sm rbb off" aria-disabled="true" aria-describedby={`sv84-w-${at}${r.id}`} data-testid={`crm-rollback-${at}-${r.id}`}>
          {locked || !cutoff ? <Lock className="i" aria-hidden /> : <RotateCcw className="i" aria-hidden />}برگشت به این نسخه
        </button>
        <span className="why" id={`sv84-w-${at}${r.id}`}>{g.reason}</span>
      </>
    );
  };

  const opTime = (() => {
    const u = data.operation?.updatedAt; const d = u ? new Date(u) : null;
    if (!d || Number.isNaN(d.getTime())) return '';
    const t = new Date(d.getTime() + 210 * 60_000);
    return `ساعت ${fa(`${String(t.getUTCHours()).padStart(2, '0')}:${String(t.getUTCMinutes()).padStart(2, '0')}`)} به وقت تهران`;
  })();
  const retryRel = opTarget ? sorted.find((r) => r.id === opTarget || r.version === opTarget) ?? null : null;
  const dismiss = <button type="button" className="icb x" onClick={() => setHideResult(opKey)} aria-label="بستن پیام"><X className="i" aria-hidden /></button>;
  const opBanner = (v: OperationView) => {
    if (v.kind === 'none' || hideResult === opKey) return null;
    if (v.kind === 'running' && mine && opTarget === mine) {
      return (
        <div className="ban run" id="opban" role="status" aria-live="polite" data-testid="ban-run">
          <span className="spn" aria-hidden />
          <div><b>در حال برگشت CRM به {nameOf(opTarget)}…</b><p>{opTime ? `آخرین خبر ${opTime}. ` : ''}{v.message}</p>
            <ol className="svstp"><li>پشتیبان از پایگاه داده</li><li className="sn" aria-current="step"><span className="spn" aria-hidden />جابه‌جایی نسخه</li><li>راه‌اندازی دوباره و بررسی سلامت</li></ol>
          </div>
        </div>
      );
    }
    if (v.kind === 'running') {
      return <Banner tone="warn" id="opban" role="status" icon={<AlertTriangle className="i" aria-hidden />} title="یک تغییر نسخه‌ی دیگر روی CRM در حال اجراست؛ تا تمام نشود، برگشت ممکن نیست.">مقصد: {nameOf(opTarget)}{opTime ? `، آخرین خبر ${opTime}` : ''}. دکمه‌های برگشت بعد از تمام شدن خودکار فعال می‌شوند.</Banner>;
    }
    if (v.kind === 'success') {
      return (
        <div className="ban ok" role="status" data-testid="ban-ok"><Check className="i" aria-hidden />
          <div><b>{mine && opTarget === mine ? `CRM به ${nameOf(opTarget)} برگشت.` : `آخرین تغییر نسخه‌ی CRM موفق بود (${nameOf(opTarget)}).`}</b><p>{opTime ? `${opTime}. ` : ''}نشان «نسخه‌ی فعلی» حالا روی همین نسخه است.</p></div>{dismiss}
        </div>
      );
    }
    if (v.kind === 'manual_recovery' || v.kind === 'unknown') {
      return <Banner tone="bad" role="alert" id="opban" icon={<AlertTriangle className="i" aria-hidden />} title={v.title}><span className="rsn">{v.message}</span>{opTime ? ` (${opTime})` : ''}</Banner>;
    }
    const canRetry = !!retryRel && gateFor(retryRel).allowed;
    return (
      <div className="ban bad" role="alert" data-testid="ban-bad"><AlertTriangle className="i" aria-hidden />
        <div><b>برگشت انجام نشد؛ CRM روی {nameOf(data.current)} ماند.</b>
          <p><span className="rsn">علت: {v.message}</span>{opTime ? ` (${opTime})` : ''} این تلاش در فهرست با وضعیت «{v.badge}» دیده می‌شود.</p>
          <div className="bb">
            {canRetry && retryRel ? <button type="button" className="btn sm p" onClick={() => open(retryRel)}><RefreshCw className="i" aria-hidden />دوباره تلاش کن</button> : null}
            <button type="button" className="btn sm" onClick={() => setHideResult(opKey)}>بستن</button>
          </div>
        </div>
      </div>
    );
  };

  const cutInfo = cutoff
    ? <Banner tone="info" icon={<Lock className="i" aria-hidden />} title="برگشت فقط به نسخه‌های هم‌ساختار">ساختار پایگاه داده از {cutoffLabel} عوض شده؛ نسخه‌های قدیمی‌تر روی داده‌ی فعلی امن نیستند و دکمه‌شان خاموش است.{cutoff === data.current ? ' چون آخرین تغییر ساختار همین نسخه‌ی فعلی است، فعلاً هیچ نسخه‌ی قدیمی‌تری قابل برگشت نیست.' : ''}</Banner>
    : <Banner tone="bad" icon={<Database className="i" aria-hidden />} title="زمان آخرین تغییر ساختار پایگاه داده معلوم نیست">تا فایل اطلاعات نسخه‌های CRM خوانده نشود، همه‌ی دکمه‌های برگشت خاموش است. به توسعه‌دهنده خبر بده.</Banner>;
  const rowCls = (r: Release) => `${r.version === data.current ? 'iscur' : ''}${isTarget(r) && (op.kind === 'failed' || op.kind === 'manual_recovery' || op.kind === 'auto_rollback') ? ' isf' : ''}`;
  const schemaTag = (m: CrmMetaEntry | null) => (m?.schemaChange ? <span className="svtg sch" title={m.schemaChange}>تغییر ساختار پایگاه داده</span> : null);

  return (
    <>
      {curRel ? <CurrentCard where="CRM" label="الان روی CRM" rid={curRel.id} no={crmNo(curMeta?.releaseNo)} commit={curMeta?.commit ?? null} branch={curMeta?.branch ?? null} desc={curMeta?.description ?? null} /> : null}
      {opBanner(op)}
      {cutInfo}
      <div className="svl" data-testid="crm-release-list">
        <table className="svt">
          <caption className="sr">فهرست نسخه‌های CRM، جدیدترین بالا</caption>
          <thead><tr><th scope="col">زمان <small>به وقت تهران</small></th><th scope="col">نسخه و وضعیت</th><th scope="col">کامیت</th><th scope="col">شاخه</th><th scope="col">توضیح</th><th scope="col"><span className="sr">کار</span></th></tr></thead>
          <tbody>
            {pg.rows.map((r) => {
              const m = metaFor(r.id, r.version);
              return (
                <tr key={r.id} className={rowCls(r)} data-testid={`crm-release-${r.id}`}>
                  <td><When rid={r.version} /></td>
                  <td><div className="rl"><VersionLabel no={crmNo(m?.releaseNo)} rid={r.id} />{r.version === data.current ? <CurBadge /> : null}</div><div className="tgs">{status(r)}{schemaTag(m)}</div></td>
                  <td><Sha sha={m?.commit ?? null} /></td>
                  <td><Branch name={m?.branch ?? null} /></td>
                  <td className="ms"><span><Msg text={m?.description} /></span>{note(r)}</td>
                  <td className="ac"><div className="acw">{action(r, 't')}</div></td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <ul className="svcs">
          {pg.rows.map((r) => {
            const m = metaFor(r.id, r.version);
            return (
              <li key={r.id} className={`svc ${rowCls(r)}`} data-testid={`crm-card-${r.id}`}>
                <div className="r1"><b>{crmNo(m?.releaseNo) ?? '—'}</b><bdi dir="ltr" className="mono hint">{r.id}</bdi>{r.version === data.current ? <CurBadge /> : null}{status(r)}{schemaTag(m)}</div>
                <p className="tw"><When rid={r.version} inline /></p>
                <p className="msg"><Msg text={m?.description} /></p>{note(r)}
                <div className="r2"><Sha sha={m?.commit ?? null} /><Branch name={m?.branch ?? null} /></div>
                <div className="ca">{action(r, 'c')}</div>
              </li>
            );
          })}
        </ul>
        <div className="svf">
          <span className="hint">صفحه‌ی {fa(pg.page)} از {fa(pg.pages)}، {fa(pg.total)} نسخه</span>
          {pg.pages > 1 ? (
            <nav className="pgn" aria-label="صفحه‌های فهرست نسخه‌های CRM">
              <button type="button" className="pgb" disabled={pg.page <= 1} onClick={() => setPage(pg.page - 1)} data-testid="rel-page-prev">قبلی</button>
              {pageWindow(pg.page, pg.pages).map((n, i) => n === 0 ? (
                <span key={`gap${i}`} className="pgg" aria-hidden="true">…</span>
              ) : (
                <button key={n} type="button" className={`pgb${n === pg.page ? ' on' : ''}`} aria-current={n === pg.page ? 'page' : undefined} aria-label={`صفحه‌ی ${fa(n)}`} onClick={() => setPage(n)}>{fa(n)}</button>
              ))}
              <button type="button" className="pgb" disabled={pg.page >= pg.pages} onClick={() => setPage(pg.page + 1)} data-testid="rel-page-next">بعدی</button>
            </nav>
          ) : null}
        </div>
      </div>
      {selected && curRel ? (
        <ConfirmDialog
          from={{ no: crmNo(curMeta?.releaseNo), rid: curRel.id, desc: curMeta?.description ?? null, commit: curMeta?.commit ?? null }}
          to={{ no: crmNo(selMeta?.releaseNo), rid: selected.id, desc: selMeta?.description ?? null, commit: selMeta?.commit ?? null }}
          pending={activateMutation.isPending}
          error={activationError}
          onCancel={close}
          onConfirm={confirm}
        />
      ) : null}
    </>
  );
}

export default function Releases() {
  const [tab, setTab] = useState<Tab>(() => (new URLSearchParams(window.location.search).get('tab') === 'crm' ? 'crm' : 'site'));
  const [shot] = useState(() => new URLSearchParams(window.location.search).get('shot') === '1'); // freezes animations for screenshots
  const pick = (t: Tab) => {
    setTab(t);
    const u = new URL(window.location.href); u.searchParams.set('tab', t); window.history.replaceState(null, '', u.toString());
  };
  const tabs: { k: Tab; l: string; icon: ReactNode }[] = [
    { k: 'site', l: 'نسخه‌های سایت', icon: <Globe className="i" aria-hidden /> },
    { k: 'crm', l: 'نسخه‌های CRM', icon: <Server className="i" aria-hidden /> },
  ];
  const onKey = (e: RKeyboardEvent<HTMLButtonElement>, k: Tab) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const n: Tab = e.key === 'Home' ? 'site' : e.key === 'End' ? 'crm' : k === 'site' ? 'crm' : 'site';
    pick(n); document.getElementById(`rel-tab-${n}`)?.focus();
  };
  return (
    <section className={`sv84 svm${shot ? ' shot' : ''}`} data-testid="page-releases">
      <header className="svhd">
        <span className="eyb">مدیریت زیرساخت</span>
        <h2>نسخه‌های سایت و CRM</h2>
        <p>همه‌ی نسخه‌ها و به‌روزرسانی‌ها؛ ساعت‌ها به وقت تهران</p>
      </header>
      <div className="svtabs" role="tablist" aria-label="نوع نسخه">
        {tabs.map((t) => (
          <button key={t.k} type="button" role="tab" id={`rel-tab-${t.k}`} aria-controls={`rel-panel-${t.k}`} aria-selected={tab === t.k} tabIndex={tab === t.k ? 0 : -1}
            className="svtab" onClick={() => pick(t.k)} onKeyDown={(e) => onKey(e, t.k)} data-testid={`tab-releases-${t.k}`}>
            {t.icon}{t.l}
          </button>
        ))}
      </div>
      <div className="svp" role="tabpanel" id={`rel-panel-${tab}`} aria-labelledby={`rel-tab-${tab}`}>
        {tab === 'site' ? <SiteTab /> : <CrmTab />}
      </div>
    </section>
  );
}
