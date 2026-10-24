/** Shared building blocks for the «خرید کالا» / «دستور پرداخت» redesign: stepper, wizard shell, confirm dialog, toast, section tabs. */
import { useEffect, useState, type ReactNode } from 'react';
import { Check, ChevronLeft, ChevronRight, X } from 'lucide-react';
import { Modal } from '@/components/DataTools';

export function Stepper({ steps, current, done, testId }: { steps: string[]; current: number; done?: boolean; testId: string }) {
  return <ol className="gp-stepper" style={{ ['--gp-steps' as string]: steps.length }} data-testid={testId}>
    {steps.map((label, i) => {
      const state = done || i < current ? 'done' : i === current ? 'current' : '';
      return <li key={label} className={state} aria-current={state === 'current' ? 'step' : undefined}>
        <span className="gp-step-dot">{state === 'done' ? <Check size={14} /> : (i + 1).toLocaleString('fa-IR')}</span>
        <strong>{label}</strong>
      </li>;
    })}
  </ol>;
}

/** Multi-step dialog: header progress bar, optional summary strip, body, back/next footer. */
export function Wizard({ title, testId, steps, step, summary, children, onClose, onBack, next }: {
  title: string; testId: string; steps: string[]; step: number; summary?: ReactNode; children: ReactNode; onClose: () => void; onBack?: () => void;
  next: { label: string; onClick: () => void; disabled?: boolean; tone?: 'primary' | 'green' | 'danger'; icon?: ReactNode; testId?: string };
}) {
  return <Modal title={title} onClose={onClose} testId={testId}>
    <div className="gp-wiz">
      <div className="gp-wiz-head"><strong>{steps[step]}</strong><span>مرحله {(step + 1).toLocaleString('fa-IR')} از {steps.length.toLocaleString('fa-IR')}</span></div>
      <div className="gp-wiz-bar" aria-hidden="true">{steps.map((s, i) => <i key={s} className={i <= step ? 'on' : ''} />)}</div>
      {summary ? <div className="gp-wiz-summary">{summary}</div> : null}
      <div className="gp-wiz-body">{children}</div>
      <div className="gp-wiz-foot">
        <button type="button" className={`btn gp-btn-${next.tone ?? 'primary'}`} disabled={next.disabled} onClick={next.onClick} data-testid={next.testId ?? `button-${testId}-next`}>{next.icon}{next.label}{next.icon ? null : <ChevronLeft size={16} />}</button>
        {onBack ? <button type="button" className="btn btn-ghost" onClick={onBack} data-testid={`button-${testId}-back`}><ChevronRight size={16} />قبلی</button>
          : <button type="button" className="btn btn-ghost" onClick={onClose}>انصراف</button>}
      </div>
    </div>
  </Modal>;
}

/** Replaces window.confirm(): optional required reason (min chars). */
export function ConfirmDialog({ title, testId, children, confirmLabel, tone = 'primary', busy, error, reason, onConfirm, onClose, icon }: {
  title: string; testId: string; children?: ReactNode; confirmLabel: string; tone?: 'primary' | 'green' | 'danger'; busy?: boolean; error?: string | null;
  reason?: { label: string; min: number; placeholder?: string; hint?: string }; onConfirm: (reason: string) => void; onClose: () => void; icon?: ReactNode;
}) {
  const [text, setText] = useState('');
  const ok = !reason || text.trim().length >= reason.min;
  return <Modal title={title} onClose={onClose} testId={testId}>
    <div className="gp-confirm">
      {children}
      {reason ? <div className="field" style={{ marginTop: 12 }}>
        <label htmlFor={`${testId}-reason`}>{reason.label} <b className="gp-req">*</b></label>
        <textarea id={`${testId}-reason`} rows={3} value={text} maxLength={500} placeholder={reason.placeholder} onChange={(e) => setText(e.target.value)} data-testid={`input-${testId}-reason`} />
        <small className="secondary-cell">{reason.hint ?? `حداقل ${reason.min.toLocaleString('fa-IR')} حرف.`}</small>
      </div> : null}
      {error ? <div className="gp-alert" role="alert">{error}</div> : null}
      <div className="gp-confirm-foot">
        <button type="button" className={`btn gp-btn-${tone}`} disabled={!ok || busy} onClick={() => onConfirm(text.trim())} data-testid={`button-${testId}-confirm`}>{icon}{busy ? 'در حال ثبت…' : confirmLabel}</button>
        <button type="button" className="btn btn-ghost" onClick={onClose}>انصراف</button>
      </div>
    </div>
  </Modal>;
}

export function Toast({ text, onDone, action }: { text: string; onDone: () => void; action?: ReactNode }) {
  useEffect(() => { const t = setTimeout(onDone, 6000); return () => clearTimeout(t); }, [text, onDone]);
  return <div className="gp-toast" role="status" data-testid="toast-goods"><Check size={16} /><span>{text}</span>{action}<button type="button" onClick={onDone} aria-label="بستن"><X size={14} /></button></div>;
}

/**
 * List sections (tabs). A page declares an array of sections; each section either filters the
 * page's own list (`kind: 'list'`) or brings its own content (`kind: 'custom'`) — the slot the
 * coming «در انتظار ایجاد» section (customers whose previous stage is done and who wait for a
 * goods purchase / payment order to be created) plugs into without touching the list code.
 */
export type ListSection<P> = {
  key: string; label: string; testId: string; tone?: 'gold';
  /** shown in the pill; undefined = no count */
  count?: number | null;
  hidden?: boolean;
} & ({ kind: 'list'; params: P } | { kind: 'custom'; render: () => ReactNode });

export function SectionTabs<P>({ sections, active, onPick, label }: { sections: ListSection<P>[]; active: string; onPick: (k: string) => void; label: string }) {
  return <div className="gp-tabs" role="tablist" aria-label={label}>
    {sections.filter((s) => !s.hidden).map((s) => <button key={s.key} type="button" role="tab" aria-selected={active === s.key}
      className={`gp-tab ${active === s.key ? 'active' : ''} ${s.tone === 'gold' ? 'gold' : ''}`} onClick={() => onPick(s.key)} data-testid={`tab-${s.testId}`}>
      <span>{s.label}</span>{s.count !== undefined && s.count !== null ? <b>{s.count.toLocaleString('fa-IR')}</b> : null}
    </button>)}
  </div>;
}
