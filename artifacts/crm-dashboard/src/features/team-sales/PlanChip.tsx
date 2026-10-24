import { Ban, FileText, X } from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { fa, type SuggestedPlan } from './api';
import { planMeta } from './plan-reasons';
import './team-sales.css';

/** Plan chip for the next salesperson (HANDOFF crm-call-form-plans §5). Display only; clicking does nothing in this phase. */
export function PlanChip({ plan, size = 'sm', testId }: { plan: Pick<SuggestedPlan, 'name' | 'status' | 'reasons'>; size?: 'sm' | 'lg'; testId?: string }) {
  const depends = plan.status === 'depends';
  const title = depends ? `${plan.name} — مشروط: ${(plan.reasons ?? []).join('؛ ')}` : plan.name;
  return <span className={`pc${depends ? ' is-cond' : ''}${size === 'lg' ? ' is-lg' : ''}`} title={title} data-testid={testId} data-status={plan.status}>
    {depends ? null : <FileText size={14} aria-hidden="true" />}
    <span className="pc-name">{plan.name}</span>
    {depends ? <span className="pc-tag">مشروط</span> : null}
  </span>;
}

/** crm-no-plan-option: grey «بدون طرح مناسب» chip (first-call form chose «هیچ طرحی به این مشتری نمی‌خوره»). */
export function NoPlanChip({ size = 'sm', testId, note }: { size?: 'sm' | 'lg'; testId?: string; note?: string | null }) {
  return <span className={`pc is-noplan${size === 'lg' ? ' is-lg' : ''}`} title={note ? `بدون طرح مناسب — ${note}` : 'بدون طرح مناسب'} data-testid={testId} data-status="noplan">
    <Ban size={14} aria-hidden="true" /><span className="pc-name">بدون طرح مناسب</span>
  </span>;
}

/**
 * List row: 2 chips + «+N» (popover on desktop, bottom sheet on mobile); «—» when there is none.
 * crm-row-menu-fix: the popover is portalled to <body> with position:fixed (it used to be absolute inside the
 * customers table wrapper, which clips with overflow-x:auto). It flips above the chip when there is no room below,
 * stays inside the viewport in RTL, and closes on outside click, Esc, scroll and resize. Phones keep the bottom sheet.
 */
export function PlanChipsRow({ plans, max = 2, testId = 'plan-chips' }: { plans: SuggestedPlan[]; max?: number; testId?: string }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<CSSProperties | null>(null);
  const wrap = useRef<HTMLSpanElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLSpanElement>(null);
  const id = useId();
  const close = (focus = false) => { setOpen(false); if (focus) btn.current?.focus(); };
  useEffect(() => {
    if (!open) return;
    const inside = (t: EventTarget | null) => t instanceof Node && (!!wrap.current?.contains(t) || !!pop.current?.contains(t));
    const onDown = (e: MouseEvent) => { if (!inside(e.target)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(true); };
    const at = btn.current?.getBoundingClientRect();
    const onScroll = (e: Event) => {
      if (e.target instanceof Node && pop.current?.contains(e.target)) return;
      // Ignore focus-induced 1–2px nudges of the table wrapper; close only when the chip really moved.
      const now = btn.current?.getBoundingClientRect();
      if (at && now && Math.abs(now.left - at.left) < 4 && Math.abs(now.top - at.top) < 4) return;
      setOpen(false);
    };
    const onResize = () => setOpen(false);
    document.addEventListener('mousedown', onDown); document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true); window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true); window.removeEventListener('resize', onResize);
    };
  }, [open]);
  useLayoutEffect(() => {
    if (!open) { setPos(null); return; }
    if (window.matchMedia('(max-width: 640px)').matches) { setPos({}); return; } // bottom sheet (CSS)
    const b = btn.current?.getBoundingClientRect(); const p = pop.current;
    if (!b || !p) return;
    const vw = window.innerWidth, vh = window.innerHeight, gap = 6, pad = 8;
    const w = p.offsetWidth, h = p.offsetHeight;
    // RTL: start edge is the right edge of the chip; keep inside the viewport.
    let left = b.right - w; left = Math.max(pad, Math.min(left, vw - w - pad));
    const below = vh - b.bottom - gap - pad, above = b.top - gap - pad;
    const up = h > below && above > below;
    const top = up ? Math.max(pad, b.top - gap - h) : b.bottom + gap;
    setPos({ position: 'fixed', top, left, maxHeight: (up ? above : below), overflowY: 'auto' });
    p.dataset.side = up ? 'top' : 'bottom';
  }, [open]);
  useEffect(() => { if (open && pos) pop.current?.focus(); }, [open, pos]);
  if (!plans.length) return <span className="pc-none" data-testid={`${testId}-none`}>—</span>;
  const shown = plans.slice(0, max), rest = plans.length - shown.length;
  return <span className="pc-row" ref={wrap} data-testid={testId} onClick={(e) => e.stopPropagation()}>
    {shown.map((p) => <PlanChip key={p.id} plan={p} />)}
    {rest > 0 ? <button ref={btn} type="button" className="pc-more" aria-label={`${fa(rest)} طرح دیگر`} aria-expanded={open} aria-controls={open ? id : undefined} aria-haspopup="dialog"
      onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }} data-testid={`${testId}-more`}>+{fa(rest)}</button> : null}
    {open ? createPortal(<span className="pc-portal" dir="rtl" onClick={(e) => e.stopPropagation()}>
      <span className="pc-sheet-scrim" aria-hidden="true" onClick={() => close(true)} />
      <span ref={pop} className="pc-pop" id={id} role="dialog" aria-label="طرح‌های پیشنهادی" tabIndex={-1} data-testid={`${testId}-popover`}
        style={pos ?? { position: 'fixed', top: 0, left: 0, visibility: 'hidden' }}>
        <span className="pc-pop-head"><b>طرح‌های پیشنهادی ({fa(plans.length)})</b>
          <button type="button" className="pc-pop-x" aria-label="بستن" onClick={() => close(true)}><X size={16} /></button></span>
        {plans.map((p) => <span key={p.id} className="pc-pop-item"><b>{p.name}{p.status === 'depends' ? <span className="pc-tag"> مشروط</span> : null}</b><small>{planMeta({ bank: p.bank, max: p.max })}</small></span>)}
      </span>
    </span>, document.body) : null}
  </span>;
}
