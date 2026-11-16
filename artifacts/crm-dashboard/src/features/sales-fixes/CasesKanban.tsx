/** SALES-FIXES 480000 (t810u items 7+8): «پرونده‌های من» as a kanban — one column per case status (FB_COLUMNS), cards inside.
 *  Opens at any step (no files lock, no board turn). Own cases only (server GET /sales-fixes/cases). A card opens the full case page;
 *  the browser back button returns here. Cards are not draggable: a status changes only through the case's own forms (unchanged rule). */
import { useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'wouter';
import { Check, Clock, FolderOpen, Layers, Plus, X } from 'lucide-react';
import { CreateWizard } from '@/components/loan-applications/CreateWizard';
import { loanStageLabel } from '@/lib/loan-labels';
import { toPersianDigits } from '@/lib/customer-id';
import { FB_COLUMNS, fbColumnOf, type FbColumn } from '@/features/today-split/columns';
import { sfApi, fa, faDay, PRIO_FA, type Sf480KCase } from './api';
import { SfSearchButton } from './SearchOverlay';
import './sf480.css';

const CLOSED = new Set<FbColumn>(['completed', 'cancelled']);

export default function CasesKanban() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['sf480-cases'], queryFn: sfApi.cases, refetchInterval: 60_000, retry: 1 });
  const [wizard, setWizard] = useState(false);
  const [sel, setSel] = useState(0);
  const [showClosed, setShowClosed] = useState<Record<string, boolean>>({});
  const wrap = useRef<HTMLDivElement>(null);
  const byCol = useMemo(() => { const m = new Map<FbColumn, Sf480KCase[]>(FB_COLUMNS.map((c) => [c.key, []])); for (const k of q.data?.cases ?? []) m.get(fbColumnOf(k.stage, k.status))!.push(k); return m; }, [q.data]);
  const goCol = (i: number) => { setSel(i); (wrap.current?.children[i] as HTMLElement | undefined)?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'start' }); };
  const onScroll = () => { const w = wrap.current; if (!w || !window.matchMedia('(max-width: 699.98px)').matches) return; const i = Math.round(Math.abs(w.scrollLeft) / Math.max(1, (w.children[0] as HTMLElement | undefined)?.offsetWidth ?? w.clientWidth)); if (i !== sel && i >= 0 && i < FB_COLUMNS.length) setSel(i); };
  return <div className="sf-kb-page" data-testid="sf-kanban">
    <div className="sf-kb-h"><h1>پرونده‌های من</h1>{q.data ? <span className="sf-mut" data-testid="sf-kb-total">{fa(q.data.total)} پرونده</span> : null}<span className="sf-sp" />
      <SfSearchButton big />
      <button type="button" className="btn btn-primary" onClick={() => setWizard(true)} data-testid="sf-kb-new"><Plus size={16} aria-hidden="true" /> ثبت پرونده جدید</button></div>
    {q.isLoading ? <div className="dp-skel" role="status">در حال بارگذاری پرونده‌ها…</div>
      : q.isError ? <div className="dp-box err" role="alert">پرونده‌ها بارگذاری نشد. <button type="button" className="btn btn-ghost" onClick={() => void q.refetch()}>تلاش دوباره</button></div>
      : <>
        <div className="sf-kb-chips" role="tablist" aria-label="ستون‌های وضعیت">{FB_COLUMNS.map((c, i) =>
          <button key={c.key} type="button" role="tab" aria-selected={i === sel} className={`sf-kb-chip${i === sel ? ' on' : ''}`} onClick={() => goCol(i)} data-testid="sf-kb-chip">{c.label}<span className="sf-kn">{fa(byCol.get(c.key)!.length)}</span></button>)}</div>
        <div className="sf-kb" ref={wrap} onScroll={onScroll} data-testid="sf-kb-board">{FB_COLUMNS.map((c) => { const items = byCol.get(c.key)!; const cl = CLOSED.has(c.key);
          const coll = cl && !showClosed[c.key];
          return <section key={c.key} className={`sf-kc${cl ? ' cl' : ''}${coll ? ' coll' : ''}`} data-testid="sf-kb-col" data-col={c.key} aria-labelledby={`sf-kh-${c.key}`}>
            <header className="sf-kh"><h3 id={`sf-kh-${c.key}`}>{c.key === 'completed' ? <Check size={15} aria-hidden="true" /> : c.key === 'cancelled' ? <X size={15} aria-hidden="true" /> : null}{c.label}</h3><span className="sf-kn" aria-label={`${fa(items.length)} پرونده`}>{fa(items.length)}</span></header>
            {cl ? <button type="button" className="btn btn-ghost sf-kt" aria-expanded={!coll} onClick={() => setShowClosed((o) => ({ ...o, [c.key]: !o[c.key] }))} data-testid="sf-kb-toggle">{coll ? 'نمایش' : 'جمع کن'}</button> : null}
            <div className="sf-kl">{items.length ? items.map((k) => <Link key={k.id} href={`/loan-applications/${k.id}`} className="sf-kcard" data-testid="sf-kb-card" data-case={k.id}>
              <span className="sf-kcn"><b>{toPersianDigits(k.customerName)}</b><span className="dp-id">#{fa(k.customerId)}</span></span>
              <span className="sf-kcm"><FolderOpen size={14} aria-hidden="true" /> پرونده {fa(k.id)}{k.planName ? <> · {toPersianDigits(k.planName)}</> : null}</span>
              <span className="sf-kcs">{loanStageLabel(k.stage)}</span>
              <span className="sf-kct"><Clock size={13} aria-hidden="true" /> آخرین فعالیت: {faDay(k.lastActivityAt) || '—'}{k.priority ? <span className="sf-pr">{PRIO_FA[k.priority] ?? ''}</span> : null}</span>
            </Link>) : <div className="sf-ke"><Layers size={22} aria-hidden="true" /><span>پرونده‌ای در این وضعیت نداری.</span></div>}</div>
          </section>; })}</div>
        <p className="sf-mut sf-kb-foot">کارت را بزن تا پرونده کامل باز شود. وضعیت پرونده فقط با فرم‌های خود پرونده عوض می‌شود. ستون‌های تکمیل‌شده و لغوشده پرونده‌های ۳۰ روز اخیرند.</p>
      </>}
    {wizard ? <CreateWizard onClose={() => { setWizard(false); void qc.invalidateQueries({ queryKey: ['sf480-cases'] }); }} /> : null}
  </div>;
}
