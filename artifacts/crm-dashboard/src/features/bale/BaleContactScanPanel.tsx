import { Fragment as Frag, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'wouter';
import { AlertCircle, ArrowRight, Check, CheckCircle2, Link2, ScanSearch, ShieldCheck, Unlink } from 'lucide-react';
import { toast } from '@/hooks/use-toast';
import { baleFetch, faNum, METHOD_LABEL, SCAN_NOTE_LABEL, SKIP_LABEL, type BaleLinkResult, type BaleScanResult, type BaleScanRow, type BaleScanStatus } from './api';
import './bale.css';

const errMsg = (e: unknown) => (e instanceof Error && e.message) || 'درخواست انجام نشد. دوباره تلاش کنید.';
const KEY = ['bale', 'contact-scan'] as const;
type Group = 'confident' | 'review' | 'notFound';
const GROUP_LABEL: Record<Group, string> = { confident: 'مطمئن', review: 'نیاز به بررسی', notFound: 'پیدا نشد' };
const NOT_FOUND_PAGE = 60;

function Steps({ at }: { at: 1 | 2 | 3 }) {
  return <ol className="bl-steps" aria-label="مراحل اسکن">{([[1, 'اسکن'], [2, 'بررسی'], [3, 'تأیید']] as const).map(([n, label]) =>
    <li key={n} data-on={n === at} data-done={n < at} aria-current={n === at ? 'step' : undefined}><span>{faNum(n)}. {label}</span></li>)}</ol>;
}
const mins = (s: number) => s >= 60 ? `${faNum(Math.ceil(s / 60))} دقیقه` : `${faNum(s)} ثانیه`;

/** «اسکن بله و اتصال مشتری»: read the Bale contact list (read-only) → review matches → confirm links. Nothing is sent to anyone. */
export function BaleContactScanPanel() {
  const qc = useQueryClient();
  const st = useQuery({ queryKey: KEY, queryFn: () => baleFetch<BaleScanStatus>('/bale/contact-scan'), retry: false, refetchOnWindowFocus: false });
  const [accountId, setAccountId] = useState<number | null>(null);
  const [scan, setScan] = useState<BaleScanResult | null>(null);
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [group, setGroup] = useState<Group>('confident');
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [picked, setPicked] = useState<Record<string, number | null>>({});
  const [links, setLinks] = useState<Record<string, { id: number; customerId: number } | null>>({});
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const [skipped, setSkipped] = useState<BaleLinkResult['skipped']>([]);
  const [nfShown, setNfShown] = useState(NOT_FOUND_PAGE);
  const d = st.data;
  const accounts = d?.accounts ?? [];
  const acc = accounts.find(a => a.id === accountId) ?? (d?.admin ? null : accounts[0] ?? null);

  const rowsAll = useMemo(() => scan ? [...scan.confident, ...scan.review, ...scan.notFound] : [], [scan]);
  const nameOf = useMemo(() => new Map(rowsAll.flatMap(r => r.candidates.map(c => [c.customerId, c.name] as const))), [rowsAll]);
  const linkOf = (r: BaleScanRow) => (r.baleUserId in links ? links[r.baleUserId] : r.link ? { id: r.link.id, customerId: r.link.customerId } : null);
  const choiceOf = (r: BaleScanRow, g: Group) => g === 'confident' ? (checked[r.baleUserId] ? r.candidates[0]?.customerId ?? null : null) : picked[r.baleUserId] ?? null;
  const plan = scan ? (['confident', 'review'] as Group[]).flatMap(g => scan[g].filter(r => !linkOf(r)).map(r => ({ r, g, cid: choiceOf(r, g) })).filter(x => x.cid != null)) : [];

  const start = async () => {
    if (!acc) return; setBusy(true); setErr(null);
    try {
      const r = await baleFetch<BaleScanResult>('/bale/contact-scan', { method: 'POST', body: d?.admin ? { accountId: acc.id } : {} });
      setScan(r); setStep(2); setLinks({}); setSkipped([]); setNfShown(NOT_FOUND_PAGE);
      setGroup(r.confident.length ? 'confident' : r.review.length ? 'review' : 'notFound');
      setChecked(Object.fromEntries(r.confident.filter(x => !x.link).map(x => [x.baleUserId, true])));
      setPicked({});
    } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); void qc.invalidateQueries({ queryKey: KEY }); }
  };
  const doLink = async (items: { baleUserId: string; customerId: number }[]) => {
    if (!scan || !items.length) return null; setBusy(true); setErr(null);
    try {
      const r = await baleFetch<BaleLinkResult>('/bale/contact-links', { method: 'POST', body: { scanId: scan.scanId, items } });
      setLinks(s => ({ ...s, ...Object.fromEntries(r.linked.map(l => [l.baleUserId, { id: l.linkId, customerId: l.customerId }])) }));
      setSkipped(r.skipped); void qc.invalidateQueries({ queryKey: ['bale'] });
      return r;
    } catch (e) { setErr(errMsg(e)); return null; } finally { setBusy(false); }
  };
  const unlink = async (r: BaleScanRow) => {
    const l = linkOf(r); if (!l) return; setBusy(true); setErr(null);
    try { await baleFetch(`/bale/contact-links/${l.id}/unlink`, { method: 'POST', body: {} }); setLinks(s => ({ ...s, [r.baleUserId]: null })); toast({ title: 'اتصال قطع شد' }); void qc.invalidateQueries({ queryKey: ['bale'] }); }
    catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };
  const linkOne = async (r: BaleScanRow, cid: number) => { const x = await doLink([{ baleUserId: r.baleUserId, customerId: cid }]); if (x?.linked.length) toast({ title: 'به مشتری وصل شد' }); else if (x?.skipped[0]) toast({ title: SKIP_LABEL[x.skipped[0].reason] ?? 'وصل نشد', variant: 'destructive' }); };
  const confirmAll = async () => {
    const x = await doLink(plan.map(p => ({ baleUserId: p.r.baleUserId, customerId: p.cid as number })));
    if (x) { setStep(2); setGroup('confident'); toast({ title: `${faNum(x.linked.length)} مخاطب به مشتری وصل شد`, description: x.skipped.length ? `${faNum(x.skipped.length)} مورد وصل نشد.` : undefined }); }
  };
  const confidentAll = () => { if (!scan) return; setChecked(c => ({ ...c, ...Object.fromEntries(scan.confident.filter(r => !linkOf(r)).map(r => [r.baleUserId, true])) })); setStep(3); };

  if (st.isLoading) return null;
  if (st.isError) return null; // 403 → no UI
  const cust = (id: number, name?: string) => <Link href={`/customers/${id}`} data-testid={`link-scan-customer-${id}`}>{name || nameOf.get(id) || `مشتری ${faNum(id)}`}</Link>;

  const Row = ({ r, g }: { r: BaleScanRow; g: Group }) => {
    const l = linkOf(r); const sel = choiceOf(r, g);
    return <li className="bl-scan-row" data-linked={Boolean(l)} data-testid={`scan-row-${r.baleUserId}`}>
      <div className="hd">
        <span className="who">
          {g === 'confident' && !l ? <input type="checkbox" checked={Boolean(checked[r.baleUserId])} onChange={e => setChecked(c => ({ ...c, [r.baleUserId]: e.target.checked }))} aria-label={`انتخاب ${r.contactName || 'مخاطب'}`} /> : null}
          <span><b dir="auto">{r.contactName || 'بدون نام'}</b>{r.phoneMasked ? <> <span className="bl-ltr muted">{r.phoneMasked}</span></> : null}</span>
        </span>
        {l ? <span className="bl-tag ok"><Check size={13} /> متصل</span> : null}
      </div>
      {l ? <div className="to"><Link2 size={14} /> {cust(l.customerId)}</div>
        : g === 'confident' && r.candidates[0] ? <div className="to"><span className="muted">مشتری:</span> {cust(r.candidates[0].customerId, r.candidates[0].name)} <span className="bl-meth" data-m={r.candidates[0].method}>{METHOD_LABEL[r.candidates[0].method]}</span></div>
        : g === 'review' ? <fieldset className="cands"><legend className="note">{r.note ? SCAN_NOTE_LABEL[r.note] : 'فقط با نام پیدا شد؛ مطمئن شوید'}</legend>
            {r.candidates.map(c => <label key={c.customerId} data-on={sel === c.customerId}>
              <input type="radio" name={`pick-${r.baleUserId}`} checked={sel === c.customerId} onChange={() => setPicked(p => ({ ...p, [r.baleUserId]: c.customerId }))} />
              {cust(c.customerId, c.name)} <span className="bl-meth" data-m={c.method}>{METHOD_LABEL[c.method]}</span>
              {c.phoneMasked ? <span className="bl-ltr muted">{c.phoneMasked}</span> : null}{c.linkedToOther ? <span className="note">به مخاطب دیگری وصل است</span> : null}</label>)}
            <label data-on={sel == null}><input type="radio" name={`pick-${r.baleUserId}`} checked={sel == null} onChange={() => setPicked(p => ({ ...p, [r.baleUserId]: null }))} /> هیچ‌کدام</label>
          </fieldset>
        : <div className="muted" style={{ fontSize: 13 }}>در مشتری‌های {scan?.byAdmin ? `کارشناس ${scan.expert}` : 'شما'} پیدا نشد.</div>}
      {g !== 'notFound' || l ? <div className="acts">
        {l ? <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void unlink(r)} data-testid={`button-scan-unlink-${r.baleUserId}`}><Unlink size={15} /> قطع اتصال</button>
          : <button type="button" className="btn" disabled={busy || sel == null} onClick={() => sel != null && void linkOne(r, sel)} data-testid={`button-scan-link-${r.baleUserId}`}><Link2 size={15} /> اتصال</button>}
      </div> : null}
    </li>;
  };

  const list = scan ? scan[group] : [];
  return <div className="panel bl-scan" data-testid="panel-bale-contact-scan" style={{ maxWidth: 720 }}>
    <h3 style={{ display: 'flex', gap: 6, alignItems: 'center', margin: 0 }}><ScanSearch size={18} /> اسکن بله و اتصال مشتری</h3>
    <Steps at={step} />
    {step === 1 ? <>
      <p className="muted" style={{ margin: 0, fontSize: 13 }}>فهرست مخاطب‌های بله {d?.admin ? 'کارشناس انتخاب‌شده' : 'شما'} فقط <b>خوانده</b> می‌شود و با {d?.admin ? 'مشتری‌های CRM' : 'مشتری‌های خودتان'} مقایسه می‌شود: اول شماره‌ی پرونده در نام مخاطب، بعد شماره‌ی موبایل، بعد نام. هیچ پیامی فرستاده نمی‌شود و مخاطبی اضافه یا حذف نمی‌شود.</p>
      {d?.admin ? <div className="bl-field"><label htmlFor="bale-scan-acc">حساب بله‌ی کدام کارشناس؟</label>
        <select id="bale-scan-acc" value={accountId ?? ''} onChange={e => setAccountId(Number(e.target.value) || null)} data-testid="select-bale-scan-account">
          <option value="">انتخاب کنید</option>{accounts.map(a => <option key={a.id} value={a.id}>{a.name}{a.links ? ` — ${faNum(a.links)} اتصال` : ''}</option>)}</select></div> : null}
      {!accounts.length ? <div className="bl-note off"><AlertCircle size={16} /><span>{d?.admin ? 'هیچ کارشناسی حساب بله‌ی وصل ندارد.' : 'اول حساب بله‌تان را وصل کنید.'}</span></div> : null}
      {d && !d.masterEnabled ? <div className="bl-note off"><AlertCircle size={16} /><span>بله فعلاً خاموش است.</span></div> : null}
      {acc && acc.session === 'down' ? <div className="bl-note off"><AlertCircle size={16} /><span>اتصال بله ناقص است؛ کمی بعد دوباره امتحان کنید.</span></div> : null}
      {acc && acc.nextScanInS > 0 ? <span className="muted" style={{ fontSize: 13 }}>اسکن بعدی تا {mins(acc.nextScanInS)} دیگر ممکن است.</span> : null}
      <ul className="bl-safe"><li><ShieldCheck size={16} /><span>نام و شماره‌ی مخاطب‌ها در CRM ذخیره نمی‌شود؛ فقط اتصال‌هایی که خودتان تأیید کنید.</span></li>
        <li><ShieldCheck size={16} /><span>هر حساب حداکثر هر {mins(d?.cooldownS ?? 300)} یک بار اسکن می‌شود.</span></li></ul>
      {err ? <p className="bl-err" role="alert"><AlertCircle size={16} /> {err}</p> : null}
      <div className="bl-acts"><button type="button" className="btn btn-primary" disabled={busy || !acc || !d?.masterEnabled || (acc?.nextScanInS ?? 0) > 0} onClick={() => void start()} data-testid="button-bale-contact-scan">
        <ScanSearch size={15} /> {busy ? 'در حال خواندن مخاطب‌ها…' : 'اسکن بله و اتصال مشتری'}</button></div>
    </> : scan ? <>
      <p className="muted" style={{ margin: 0, fontSize: 13 }} data-testid="scan-source">{faNum(scan.counts.contacts)} مخاطب از {scan.source === 'contacts' ? 'فهرست مخاطب‌های بله' : 'گفتگوهای بله (فهرست مخاطب در دسترس نبود)'}{scan.byAdmin ? ` — حساب ${scan.expert} (فقط مشتری‌های همین کارشناس)` : ''}{scan.truncated ? '؛ فقط بخشی از فهرست خوانده شد' : ''}.</p>
      <div className="bl-scan-sum" role="group" aria-label="گروه‌ها">{(['confident', 'review', 'notFound'] as Group[]).map(g =>
        <button key={g} type="button" data-g={g} aria-pressed={group === g && step === 2} onClick={() => { setGroup(g); setStep(2); }} data-testid={`button-scan-group-${g}`}><b>{faNum(scan[g].length)}</b><span>{GROUP_LABEL[g]}</span></button>)}</div>
      {err ? <p className="bl-err" role="alert"><AlertCircle size={16} /> {err}</p> : null}
      {skipped.length ? <div className="bl-note off" data-testid="scan-skipped"><AlertCircle size={16} /><span>{faNum(skipped.length)} مورد وصل نشد: {[...new Set(skipped.map(s => SKIP_LABEL[s.reason] ?? s.reason))].join('، ')}</span></div> : null}
      {step === 2 ? <>
        {!list.length ? <span className="muted">موردی در این گروه نیست.</span>
          : <ul className="bl-scan-list">{(group === 'notFound' ? list.slice(0, nfShown) : list).map(r => <Frag key={r.baleUserId}>{Row({ r, g: group })}</Frag>)}</ul>}
        {group === 'notFound' && list.length > nfShown ? <button type="button" className="btn btn-ghost" onClick={() => setNfShown(n => n + NOT_FOUND_PAGE)}>نمایش بیشتر ({faNum(list.length - nfShown)})</button> : null}
        <div className="bl-scan-bar">
          <button type="button" className="btn btn-primary" disabled={busy || !scan.confident.some(r => !linkOf(r))} onClick={confidentAll} data-testid="button-scan-connect-confident"><CheckCircle2 size={15} /> اتصال همه‌ی مطمئن‌ها</button>
          <button type="button" className="btn" disabled={busy || !plan.length} onClick={() => setStep(3)} data-testid="button-scan-next">ادامه ({faNum(plan.length)})</button>
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => { setScan(null); setStep(1); }}>اسکن دوباره</button>
        </div>
      </> : <>
        <div className="bl-done" style={{ textAlign: 'start' }} data-testid="scan-confirm"><span><b>{faNum(plan.length)}</b> مخاطب به این مشتری‌ها وصل می‌شود:</span></div>
        <ul className="bl-scan-list">{plan.map(p => <li key={p.r.baleUserId} className="bl-scan-row"><div className="to"><b dir="auto">{p.r.contactName || 'بدون نام'}</b> ← {cust(p.cid as number)} <span className="bl-meth" data-m={p.r.candidates.find(c => c.customerId === p.cid)?.method ?? 'manual'}>{METHOD_LABEL[p.r.candidates.find(c => c.customerId === p.cid)?.method ?? 'manual']}</span></div></li>)}</ul>
        <ul className="bl-safe"><li><ShieldCheck size={16} /><span>فقط اتصال ذخیره می‌شود؛ پرونده‌ی مشتری تغییر نمی‌کند و پیامی فرستاده نمی‌شود. هر اتصال بعداً قابل قطع است.</span></li></ul>
        <div className="bl-scan-bar">
          <button type="button" className="btn btn-primary" disabled={busy || !plan.length} onClick={() => void confirmAll()} data-testid="button-scan-confirm"><Link2 size={15} /> {busy ? 'لطفاً صبر کنید…' : `تأیید و اتصال (${faNum(plan.length)})`}</button>
          <button type="button" className="btn" disabled={busy} onClick={() => setStep(2)}><ArrowRight size={15} /> مرحله‌ی قبل</button>
        </div>
      </>}
    </> : null}
  </div>;
}
