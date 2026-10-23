import { createContext, useCallback, useContext, useEffect, useRef, useState, type KeyboardEvent, type ReactNode, type SyntheticEvent } from 'react';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import { Stepper, type WizardStep } from './Wizard';

/**
 * Step-by-step layout for an existing <form>. Only presentation changes. Every step stays mounted (inactive
 * steps are `hidden`), so the form keeps one state object and one submit handler, and API payloads stay
 * exactly the same. «ادامه» checks the native validity of the current step only. If the final submit finds
 * an invalid field in another step, the wizard jumps to that step and shows the browser message.
 */

type Ctx = { current: string };
const StepCtx = createContext<Ctx>({ current: '' });

export function FormStep({ step, children, className = '' }: { step: string; children: ReactNode; className?: string }) {
  const { current } = useContext(StepCtx);
  const active = current === step;
  return <div className={`nf-form-step ${className}`} data-form-step={step} hidden={!active} aria-hidden={!active || undefined}>{children}</div>;
}

const fields = (root: Element | null) => Array.from(root?.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input,select,textarea') ?? []);

export function StepForm<K extends string>({ steps, children, submit, onCancel, cancelLabel = 'انصراف', testPrefix = 'stepform', allowJump = true, initialStep, onStepChange, beforeNext, footerExtra, cancelTestId, cancelDisabled, className = '', bodyClassName = '', actionsExtra, step, compact = false }: {
  steps: readonly WizardStep<K>[];
  children: ReactNode;
  /** The form's original submit button(s), shown on the last step. */
  submit: ReactNode;
  onCancel?: () => void;
  cancelLabel?: string;
  testPrefix?: string;
  /** Edit forms can jump to any step from the stepper. */
  allowJump?: boolean;
  initialStep?: K;
  onStepChange?: (step: K) => void;
  /** Extra check before leaving a step; return an error message to stay on the step. */
  beforeNext?: (step: K) => string | null | undefined;
  /** Shown above the buttons on every step (e.g. server errors). */
  footerExtra?: ReactNode;
  /** Keeps the original cancel button's test id. */
  cancelTestId?: string;
  cancelDisabled?: boolean;
  className?: string;
  bodyClassName?: string;
  /** Extra buttons kept in the action bar on every step (e.g. «افزودن یادآور»). */
  actionsExtra?: ReactNode;
  /** Controlled mode: the parent owns the current step (use with onStepChange). */
  step?: K;
  /** Many short steps (one question each): always use the progress bar instead of numbered circles. */
  compact?: boolean;
}) {
  const [own, setCurrent] = useState<K>(initialStep ?? steps[0].key);
  // A step can disappear (e.g. «ضامن دارد» → خیر); fall back to the last remaining step.
  const wanted = step ?? own;
  const current = steps.some(s => s.key === wanted) ? wanted : steps[steps.length - 1].key;
  const [stepError, setStepError] = useState('');
  const root = useRef<HTMLDivElement>(null);
  const jumping = useRef(false);
  // Short guard after reaching the last step, so a double-click on «ادامه» cannot submit the form.
  const [arrived, setArrived] = useState(false);
  const index = Math.max(0, steps.findIndex(s => s.key === current));
  const isLast = index === steps.length - 1;
  const go = useCallback((key: K) => { setStepError(''); setCurrent(key); onStepChange?.(key); }, [onStepChange]);

  useEffect(() => {
    if (!isLast) return;
    setArrived(true);
    const timer = setTimeout(() => setArrived(false), 450);
    return () => clearTimeout(timer);
  }, [isLast]);

  useEffect(() => {
    // Keep the newly shown step in view inside scrollable modals.
    root.current?.scrollIntoView({ block: 'nearest' });
    const first = root.current?.querySelector<HTMLElement>(`[data-form-step="${current}"] input:not([type=hidden]):not(:disabled), [data-form-step="${current}"] select:not(:disabled), [data-form-step="${current}"] textarea:not(:disabled)`);
    if (first && window.matchMedia('(pointer: fine)').matches) first.focus({ preventScroll: true });
  }, [current]);

  const validCurrent = () => {
    const section = root.current?.querySelector(`[data-form-step="${current}"]`) ?? null;
    const invalid = fields(section).find(el => el.willValidate && !el.checkValidity());
    if (invalid) { invalid.reportValidity(); return false; }
    const custom = beforeNext?.(current);
    if (custom) { setStepError(custom); return false; }
    return true;
  };
  const next = () => { if (!isLast && validCurrent()) go(steps[index + 1].key); };
  const back = () => { if (index > 0) go(steps[index - 1].key); };

  const onInvalidCapture = (event: SyntheticEvent) => {
    const target = event.target as HTMLElement;
    const owner = target.closest('[data-form-step]')?.getAttribute('data-form-step') as K | null;
    // Only the first invalid control of a submit attempt decides where to go.
    if (jumping.current) return;
    jumping.current = true;
    setTimeout(() => { jumping.current = false; }, 120);
    if (!owner || owner === current) return;
    go(owner);
    setTimeout(() => { (target as HTMLInputElement).reportValidity?.(); }, 60);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    const target = event.target as HTMLElement;
    if (event.key !== 'Enter' || isLast || target.tagName !== 'INPUT') return;
    const type = (target as HTMLInputElement).type;
    if (type === 'checkbox' || type === 'radio' || type === 'button' || type === 'submit') return;
    event.preventDefault();
    next();
  };

  return (
    <StepCtx.Provider value={{ current }}>
      <div className={`nf-stepform ${className}`} ref={root} onInvalidCapture={onInvalidCapture} onKeyDown={onKeyDown} data-testid={`${testPrefix}`} data-step={current}>
        <Stepper steps={steps} current={current} onGo={go} allowJump={allowJump} className={compact ? 'nf-stepper-sm nf-stepper-force-compact' : 'nf-stepper-sm'} testPrefix={`${testPrefix}-step-`} />
        {steps[index]?.hint ? <p className="nf-stepform-hint">{steps[index].hint}</p> : null}
        <div className={`nf-stepform-body ${bodyClassName}`}>{children}</div>
        {stepError ? <div className="nf-stepform-error" role="alert">{stepError}</div> : null}
        {footerExtra}
        <div className="nf-stepform-actions">
          <div className="nf-stepform-primary">
            {/* Different keys so React never turns the «ادامه» button into the submit button mid-click. */}
            {isLast
              ? <div key="submit" className="nf-stepform-submit" style={arrived ? { pointerEvents: 'none' } : undefined}>{submit}</div>
              : <button key="next" type="button" className="btn btn-primary" onClick={next} data-testid={`button-${testPrefix}-next`}>ادامه <ArrowLeft size={16} /></button>}
          </div>
          <div className="nf-stepform-secondary">
            {index > 0 ? <button type="button" className="btn btn-ghost" onClick={back} data-testid={`button-${testPrefix}-back`}><ArrowRight size={16} /> مرحله قبل</button> : null}
            {onCancel ? <button type="button" className="btn btn-ghost nf-stepform-cancel" onClick={onCancel} disabled={cancelDisabled} data-testid={cancelTestId ?? `button-${testPrefix}-cancel`}>{cancelLabel}</button> : null}
          </div>
          {actionsExtra ? <div className="nf-stepform-extra">{actionsExtra}</div> : null}
        </div>
      </div>
    </StepCtx.Provider>
  );
}
