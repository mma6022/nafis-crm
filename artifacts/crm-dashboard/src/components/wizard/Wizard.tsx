import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, Check, ChevronDown, Loader2 } from 'lucide-react';

/**
 * Shared step-by-step (wizard) building blocks for Nafis CRM.
 *
 * Rule of thumb: one small group of fields per step, a clear «مرحله X از N» progress indicator,
 * back/next, progress saved between steps, smart defaults, and optional fields behind «بیشتر».
 * Styles live in src/theme/nafis-theme.css (.nf-stepper, .nf-wizard-actions, .nf-more).
 */

export type WizardStep<K extends string = string> = { key: K; title: string; hint?: string };

const faDigits = (value: number | string) => String(value).replace(/\d/g, d => '۰۱۲۳۴۵۶۷۸۹'[Number(d)]);

/** Progress indicator: compact bar + «مرحله X از N» on phones, numbered circles with names on wider screens. */
export function Stepper<K extends string>({ steps, current, onGo, className = '', testPrefix = 'wizard-step-' }: {
  steps: readonly WizardStep<K>[];
  current: K;
  /** When given, completed steps become clickable (going back never loses data). */
  onGo?: (key: K) => void;
  className?: string;
  testPrefix?: string;
}) {
  const index = Math.max(0, steps.findIndex(step => step.key === current));
  const active = steps[index];
  return (
    <nav className={`nf-stepper ${className}`} aria-label={`مرحله ${faDigits(index + 1)} از ${faDigits(steps.length)}: ${active?.title ?? ''}`}>
      <div className="nf-stepper-compact" aria-hidden="true">
        <div className="nf-stepper-compact-head"><b>{active?.title}</b><span>مرحله {faDigits(index + 1)} از {faDigits(steps.length)}</span></div>
        <div className="nf-stepper-bar">{steps.map((step, i) => <span key={step.key} className={i <= index ? 'is-on' : ''} />)}</div>
        <div className="nf-stepper-names">{steps.map((step, i) => <span key={step.key} className={i === index ? 'is-current' : i < index ? 'is-done' : ''}>{step.title}</span>)}</div>
      </div>
      <ol className="nf-stepper-full">
        {steps.map((step, i) => {
          const state = i < index ? 'done' : i === index ? 'current' : 'todo';
          const clickable = Boolean(onGo) && state === 'done';
          const content = <>
            <span className="nf-stepper-dot">{state === 'done' ? <Check size={16} strokeWidth={3} /> : faDigits(i + 1)}</span>
            <span className="nf-stepper-title">{step.title}</span>
          </>;
          return (
            <li key={step.key} className={`nf-stepper-item is-${state}`} aria-current={state === 'current' ? 'step' : undefined}>
              {clickable
                ? <button type="button" className="nf-stepper-btn" onClick={() => onGo?.(step.key)} data-testid={`${testPrefix}${step.key}`}>{content}</button>
                : <span className="nf-stepper-btn" data-testid={`${testPrefix}${step.key}`}>{content}</span>}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

type Stored<K extends string, T> = { step: K; data: T; savedAt: number };

/**
 * Wizard state with progress saved between steps (sessionStorage by default, so a refresh or
 * accidental back-navigation keeps what the user typed). Never put secrets (OTP codes, passwords) in `data`.
 */
export function useWizard<K extends string, T extends Record<string, unknown>>({ id, steps, initial, storage = 'session', maxAgeMs = 30 * 60_000 }: {
  id: string;
  steps: readonly WizardStep<K>[];
  initial: T;
  storage?: 'session' | 'local' | 'none';
  maxAgeMs?: number;
}) {
  const key = `nafis.wizard.${id}`;
  const store = typeof window === 'undefined' || storage === 'none' ? null : storage === 'local' ? window.localStorage : window.sessionStorage;
  const [state, setState] = useState<Stored<K, T>>(() => {
    const fallback = { step: steps[0].key, data: initial, savedAt: Date.now() };
    try {
      const raw = store?.getItem(key);
      if (!raw) return fallback;
      const parsed = JSON.parse(raw) as Stored<K, T>;
      if (!parsed || Date.now() - parsed.savedAt > maxAgeMs || !steps.some(s => s.key === parsed.step)) return fallback;
      return { ...parsed, data: { ...initial, ...parsed.data } };
    } catch { return fallback; }
  });
  useEffect(() => {
    try { store?.setItem(key, JSON.stringify({ ...state, savedAt: Date.now() })); } catch { /* storage full / disabled */ }
  }, [key, state, store]);
  const index = steps.findIndex(s => s.key === state.step);
  const goTo = useCallback((step: K) => setState(s => ({ ...s, step })), []);
  const next = useCallback(() => setState(s => { const i = steps.findIndex(x => x.key === s.step); return { ...s, step: steps[Math.min(steps.length - 1, i + 1)].key }; }), [steps]);
  const back = useCallback(() => setState(s => { const i = steps.findIndex(x => x.key === s.step); return { ...s, step: steps[Math.max(0, i - 1)].key }; }), [steps]);
  const update = useCallback((patch: Partial<T>) => setState(s => ({ ...s, data: { ...s.data, ...patch } })), []);
  const reset = useCallback(() => { try { store?.removeItem(key); } catch { /* ignore */ } setState({ step: steps[0].key, data: initial, savedAt: Date.now() }); }, [key, store, steps]); // eslint-disable-line react-hooks/exhaustive-deps
  return useMemo(() => ({
    step: state.step, index, total: steps.length, data: state.data,
    isFirst: index <= 0, isLast: index === steps.length - 1,
    goTo, next, back, update, reset,
  }), [state, index, steps.length, goTo, next, back, update, reset]);
}

/** Back / next row. Sticks to the bottom on phones so the primary action is always reachable. */
export function WizardActions({ onBack, backLabel = 'مرحله قبل', nextLabel = 'ادامه', nextType = 'submit', onNext, pending = false, pendingLabel, nextDisabled = false, testPrefix = 'wizard' }: {
  onBack?: () => void;
  backLabel?: string;
  nextLabel?: ReactNode;
  nextType?: 'submit' | 'button';
  onNext?: () => void;
  pending?: boolean;
  pendingLabel?: string;
  nextDisabled?: boolean;
  testPrefix?: string;
}) {
  return (
    <div className="nf-wizard-actions" data-sticky>
      <button type={nextType} className="nf-btn nf-btn-primary" onClick={onNext} disabled={pending || nextDisabled} aria-busy={pending || undefined} data-testid={`button-${testPrefix}-next`}>
        {pending ? <><Loader2 className="nf-spin" size={18} /> {pendingLabel ?? 'لطفاً صبر کنید…'}</> : <>{nextLabel} <ArrowLeft size={18} /></>}
      </button>
      {onBack && <button type="button" className="nf-btn nf-btn-ghost" onClick={onBack} disabled={pending} data-testid={`button-${testPrefix}-back`}><ArrowRight size={18} /> {backLabel}</button>}
    </div>
  );
}

/** Optional fields hidden behind «بیشتر» so a step shows only what is required. */
export function MoreFields({ label = 'اطلاعات بیشتر (اختیاری)', defaultOpen = false, children }: { label?: string; defaultOpen?: boolean; children: ReactNode }) {
  return (
    <details className="nf-more" open={defaultOpen}>
      <summary><ChevronDown size={18} className="nf-more-chevron" /> {label}</summary>
      <div className="nf-more-body">{children}</div>
    </details>
  );
}
