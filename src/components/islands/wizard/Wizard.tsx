/**
 * Reusable step-by-step Wizard shell (Mohammad's rule: every multi-step task is a wizard).
 * - "مرحله X از N" + progress bar, one small group of fields per step
 * - Back / Next, per-step validation, Enter = Next
 * - Progress saved to localStorage (versioned, 7-day TTL) so a refresh keeps the user's place
 * - Focus moves to the step title on change (screen readers + keyboard)
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from '../../ui/react';
import { toFaDigits } from '../../../lib/format';

export type StepErrors = Record<string, string | undefined>;
export type StepCtx<T> = { data: T; set: <K extends keyof T>(key: K, value: T[K]) => void; errors: StepErrors };
export type WizardStep<T> = {
  id: string;
  title: string;
  description?: string;
  render: (ctx: StepCtx<T>) => ReactNode;
  /** Return {} / undefined when valid, or { field: 'message' }. */
  validate?: (data: T) => StepErrors | undefined;
};

type Saved<T> = { v: number; at: number; step: number; data: T };
const TTL = 7 * 24 * 3600 * 1000;

export function Wizard<T extends object>({
  storageKey,
  version = 1,
  steps,
  initial,
  pinned,
  onSubmit,
  done,
  submitLabel = 'ثبت درخواست',
}: {
  storageKey: string;
  version?: number;
  steps: WizardStep<T>[];
  initial: T;
  /** Fields that win over restored progress (e.g. a plan chosen via deep link). */
  pinned?: Partial<T>;
  onSubmit: (data: T) => Promise<void>;
  done: (data: T, restart: () => void) => ReactNode;
  submitLabel?: string;
}) {
  const [step, setStep] = useState(0);
  const [data, setData] = useState<T>(initial);
  const [errors, setErrors] = useState<StepErrors>({});
  const [status, setStatus] = useState<'idle' | 'submitting' | 'done' | 'error'>('idle');
  const [hydrated, setHydrated] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const firstRender = useRef(true);

  // Restore saved progress after hydration (keeps SSR markup = step 1, no mismatch).
  useEffect(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) {
        const s = JSON.parse(raw) as Saved<T>;
        if (s.v === version && Date.now() - s.at < TTL) {
          setData({ ...initial, ...s.data, ...pinned });
          setStep(Math.min(s.step, steps.length - 1));
        }
      }
    } catch {
      /* ignore corrupt storage */
    }
    setHydrated(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!hydrated || status === 'done') return;
    try {
      localStorage.setItem(storageKey, JSON.stringify({ v: version, at: Date.now(), step, data } satisfies Saved<T>));
    } catch {
      /* quota / private mode */
    }
  }, [hydrated, storageKey, version, step, data, status]);

  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    headingRef.current?.focus({ preventScroll: true });
    headingRef.current?.closest('[data-wizard]')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [step]);

  const set = useCallback(<K extends keyof T>(key: K, value: T[K]) => {
    setData((d) => ({ ...d, [key]: value }));
    setErrors((e) => {
      if (!((key as string) in e)) return e;
      const n = { ...e };
      delete n[key as string];
      return n;
    });
  }, []);

  const current = steps[step]!;
  const isLast = step === steps.length - 1;
  const total = steps.length;

  const restart = () => {
    try {
      localStorage.removeItem(storageKey);
    } catch {
      /* */
    }
    setData(initial);
    setStep(0);
    setStatus('idle');
  };

  const next = async () => {
    const errs = current.validate?.(data) ?? {};
    setErrors(errs);
    if (Object.values(errs).some(Boolean)) return;
    if (!isLast) {
      setStep((s) => s + 1);
      return;
    }
    setStatus('submitting');
    try {
      await onSubmit(data);
      try {
        localStorage.removeItem(storageKey);
      } catch {
        /* */
      }
      setStatus('done');
    } catch {
      setStatus('error');
    }
  };
  const back = () => {
    setErrors({});
    setStep((s) => Math.max(0, s - 1));
  };

  if (status === 'done') return <div data-wizard>{done(data, restart)}</div>;

  return (
    <div data-wizard className="scroll-mt-24">
      <div className="mb-6" aria-live="polite">
        <div className="mb-2 flex items-center justify-between text-sm font-semibold">
          <span className="text-brand-600">
            مرحله {toFaDigits(step + 1)} از {toFaDigits(total)}
          </span>
          <span className="text-ink-muted">{current.title}</span>
        </div>
        <div
          className="flex gap-1.5"
          role="progressbar"
          aria-valuemin={1}
          aria-valuemax={total}
          aria-valuenow={step + 1}
          aria-label="پیشرفت"
        >
          {steps.map((s, i) => (
            <span
              key={s.id}
              className={`h-2 flex-1 rounded-full transition-colors ${i <= step ? 'bg-brand-600' : 'bg-line'}`}
            />
          ))}
        </div>
      </div>

      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void next();
        }}
      >
        <h2 ref={headingRef} tabIndex={-1} className="text-ink text-2xl font-extrabold outline-none sm:text-[28px]">
          {current.title}
        </h2>
        {current.description && <p className="text-ink-muted mt-2">{current.description}</p>}
        <div className="mt-6 space-y-5">{current.render({ data, set, errors })}</div>

        {status === 'error' && (
          <p role="alert" className="bg-danger-50 text-danger mt-5 rounded-[var(--radius)] px-4 py-3 font-semibold">
            ارسال انجام نشد. اتصال اینترنت را بررسی کنید و دوباره تلاش کنید.
          </p>
        )}

        <div className="border-line-soft sticky bottom-0 -mx-5 mt-8 flex gap-3 border-t bg-white/95 px-5 py-4 backdrop-blur sm:static sm:mx-0 sm:border-0 sm:bg-transparent sm:px-0 sm:py-0">
          {step > 0 && (
            <Button variant="secondary" onClick={back} className="flex-none">
              قبلی
            </Button>
          )}
          <Button type="submit" className="flex-1 sm:min-w-48 sm:flex-none" disabled={status === 'submitting'}>
            {status === 'submitting' ? 'در حال ارسال…' : isLast ? submitLabel : 'ادامه'}
          </Button>
        </div>
      </form>
    </div>
  );
}
