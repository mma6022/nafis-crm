import { FileText, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
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

/** List row: 2 chips + «+N» (popover on desktop, bottom sheet on mobile); «—» when there is none. */
export function PlanChipsRow({ plans, max = 2, testId = 'plan-chips' }: { plans: SuggestedPlan[]; max?: number; testId?: string }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown); document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);
  if (!plans.length) return <span className="pc-none" data-testid={`${testId}-none`}>—</span>;
  const shown = plans.slice(0, max), rest = plans.length - shown.length;
  return <span className="pc-row" ref={wrap} data-testid={testId} onClick={(e) => e.stopPropagation()}>
    {shown.map((p) => <PlanChip key={p.id} plan={p} />)}
    {rest > 0 ? <button type="button" className="pc-more" aria-label={`${fa(rest)} طرح دیگر`} aria-expanded={open} aria-controls={id}
      onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }} data-testid={`${testId}-more`}>+{fa(rest)}</button> : null}
    {open ? <>
      <span className="pc-sheet-scrim" aria-hidden="true" onClick={() => setOpen(false)} />
      <span className="pc-pop" id={id} role="dialog" aria-label="طرح‌های پیشنهادی" data-testid={`${testId}-popover`}>
        <span className="pc-pop-head"><b>طرح‌های پیشنهادی ({fa(plans.length)})</b>
          <button type="button" className="pc-pop-x" aria-label="بستن" onClick={() => setOpen(false)}><X size={16} /></button></span>
        {plans.map((p) => <span key={p.id} className="pc-pop-item"><b>{p.name}{p.status === 'depends' ? <span className="pc-tag"> مشروط</span> : null}</b><small>{planMeta({ bank: p.bank, max: p.max })}</small></span>)}
      </span>
    </> : null}
  </span>;
}
