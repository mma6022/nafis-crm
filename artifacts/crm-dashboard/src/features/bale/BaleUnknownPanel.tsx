import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'wouter';
import { AlertCircle, ArrowRight, Check, Link2, Search, ShieldCheck, UserX } from 'lucide-react';
import { toast } from '@/hooks/use-toast';
import { baleFetch, baleWhen, faNum, type BaleOwnCustomer, type BaleUnknownChat } from './api';
import './bale.css';

const errMsg = (e: unknown) => (e instanceof Error && e.message) || 'درخواست انجام نشد. دوباره تلاش کنید.';
const KEY = ['bale', 'unknown'] as const;

function Steps({ at }: { at: 1 | 2 }) {
  return <ol className="bl-steps" aria-label="مراحل وصل کردن">{([[1, 'کدام مشتری؟'], [2, 'تأیید']] as const).map(([n, label]) =>
    <li key={n} data-on={n === at} data-done={n < at} aria-current={n === at ? 'step' : undefined}><span>{faNum(n)}. {label}</span></li>)}</ol>;
}

/** Two-step «وصل به مشتری»: search the expert's OWN customers → confirm. Only the chat link is stored; earlier text never is. */
function LinkWizard({ chat, onDone, onClose }: { chat: BaleUnknownChat; onDone: (customerId: number) => void; onClose: () => void }) {
  const [q, setQ] = useState(''); const [term, setTerm] = useState(''); const [pick, setPick] = useState<BaleOwnCustomer | null>(null);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  useEffect(() => { const t = window.setTimeout(() => setTerm(q.trim()), 300); return () => window.clearTimeout(t); }, [q]);
  const res = useQuery({ queryKey: ['bale', 'my-customers', term], enabled: term.length >= 2,
    queryFn: () => baleFetch<{ items: BaleOwnCustomer[] }>(`/bale/my-customers?q=${encodeURIComponent(term)}`) });
  const link = async () => {
    if (!pick) return; setBusy(true); setErr(null);
    try { await baleFetch(`/bale/unknown/${chat.id}/link`, { method: 'POST', body: { customerId: pick.id } }); onDone(pick.id); }
    catch (x) { setErr(errMsg(x)); } finally { setBusy(false); }
  };
  return <div className="bl-wiz bl-link" data-testid={`bale-link-wizard-${chat.id}`}>
    <Steps at={pick ? 2 : 1} />
    {!pick ? <>
      <div className="bl-field">
        <label htmlFor={`bale-uq-${chat.id}`}><Search size={15} style={{ verticalAlign: '-2px' }} /> نام یا چهار رقم از شماره‌ی مشتری</label>
        <input id={`bale-uq-${chat.id}`} value={q} onChange={e => setQ(e.target.value)} placeholder="مثلاً رضایی یا ۴۵۶۷" autoComplete="off" data-testid="input-bale-unknown-search" />
        <span className="hint">فقط مشتری‌های خودتان نشان داده می‌شوند.</span>
      </div>
      {term.length >= 2 ? res.isLoading ? <span className="muted">در حال جستجو…</span>
        : !res.data?.items.length ? <span className="muted" data-testid="bale-unknown-noresult">مشتری‌ای از فهرست شما پیدا نشد.</span>
        : <ul className="bl-pick" role="listbox" aria-label="مشتری‌های من">{res.data.items.map(c => <li key={c.id}>
            <button type="button" role="option" aria-selected={false} onClick={() => setPick(c)} data-testid={`button-bale-pick-${c.id}`}>
              <b>{c.name}</b><span className="bl-ltr">{c.phone ?? c.phoneMasked ?? '—'}</span></button></li>)}</ul> : null}
      <div className="bl-acts"><button type="button" className="btn btn-ghost" onClick={onClose}>انصراف</button></div>
    </> : <>
      <div className="bl-done" style={{ textAlign: 'start' }}>
        <span>این گفتگوی بله به <b>{pick.name}</b> (<span className="bl-ltr">{pick.phone ?? pick.phoneMasked ?? '—'}</span>) وصل شود؟</span>
      </div>
      <ul className="bl-safe">
        <li><ShieldCheck size={16} /><span>فقط پیوند گفتگو ذخیره می‌شود؛ پیام‌های قبل از این لحظه ذخیره نشده‌اند و نمی‌شوند.</span></li>
        <li><ShieldCheck size={16} /><span>از این به بعد پیام‌های این گفتگو در برگه‌ی «گفتگوی بله»ی همین مشتری می‌آید. این کار در گزارش رویدادها ثبت می‌شود.</span></li>
      </ul>
      {err ? <p className="bl-err" role="alert"><AlertCircle size={16} /> {err}</p> : null}
      <div className="bl-acts">
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void link()} data-testid="button-bale-link-confirm"><Link2 size={15} /> {busy ? 'لطفاً صبر کنید…' : 'وصل کن'}</button>
        <button type="button" className="btn" disabled={busy} onClick={() => { setPick(null); setErr(null); }}><ArrowRight size={15} /> مرحله‌ی قبل</button>
      </div>
    </>}
  </div>;
}

/** «پیام از شماره‌ی ناشناس» on /settings/bale (the bell links here with ?unknown=<id>). */
export function BaleUnknownPanel() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: KEY, queryFn: () => baleFetch<{ items: BaleUnknownChat[] }>('/bale/unknown'), retry: false, refetchInterval: 60_000 });
  const fromBell = Number(new URLSearchParams(window.location.search).get('unknown')) || null;
  const [open, setOpen] = useState<number | null>(fromBell);
  const [done, setDone] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const items = q.data?.items ?? [];
  const refresh = () => qc.invalidateQueries({ queryKey: ['bale'] });
  const dismiss = async (id: number) => {
    setBusy(true);
    try { await baleFetch(`/bale/unknown/${id}/dismiss`, { method: 'POST', body: {} }); toast({ title: 'کنار گذاشته شد', description: 'از این گفتگو دیگر اعلانی نمی‌آید.' }); }
    catch (x) { toast({ title: errMsg(x), variant: 'destructive' }); } finally { setBusy(false); void refresh(); }
  };
  if (!items.length && !done) return null;
  return <div className="panel" data-testid="panel-bale-unknown" style={{ display: 'grid', gap: 10, maxWidth: 560 }}>
    <h3 style={{ display: 'flex', gap: 6, alignItems: 'center', margin: 0 }}><UserX size={18} /> پیام از شماره‌ی ناشناس {items.length ? <span className="bl-tag warn">{faNum(items.length)}</span> : null}</h3>
    <p className="muted" style={{ margin: 0, fontSize: 13 }}>کسانی که در فهرست مشتری‌های شما نیستند ولی در بله پیام دادند. متن پیامشان ذخیره نشده است. اگر یکی از مشتری‌های خودتان است، گفتگو را به پرونده‌اش وصل کنید.</p>
    {done ? <div className="bl-info" role="status" data-testid="bale-unknown-linked"><Check size={16} /> وصل شد. <Link href={`/customers/${done}#sec-bale`}>رفتن به پرونده</Link></div> : null}
    <ul className="bl-queue">{items.map(x => <li key={x.id} data-testid={`bale-unknown-${x.id}`} data-focus={x.id === fromBell || undefined}>
      <div className="top"><span className="who">گفتگوی ناشناس</span>
        <span className="muted">{faNum(x.messages)} پیام؛ آخرین: {baleWhen(x.lastAt)}</span></div>
      {open === x.id ? <LinkWizard chat={x} onClose={() => setOpen(null)} onDone={cid => { setOpen(null); setDone(cid); toast({ title: 'گفتگوی بله به مشتری وصل شد' }); void refresh(); }} />
        : <div className="bl-acts">
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => { setDone(null); setOpen(x.id); }} data-testid={`button-bale-link-${x.id}`}><Link2 size={15} /> وصل به مشتری</button>
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void dismiss(x.id)} data-testid={`button-bale-dismiss-${x.id}`}>مشتری من نیست</button>
        </div>}
    </li>)}</ul>
  </div>;
}
