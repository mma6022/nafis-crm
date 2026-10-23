/** Stepper from the design system: back button, current step name, «مرحله ۲ از ۳», segmented 6px bar, labels. */
import { Icon } from './icons';
import { fa } from '../../lib/plans';

export function Stepbar({
  index,
  labels,
  current,
  onBack,
  doneText,
  backLabel = 'قبلی',
}: {
  /** 0-based; index === labels.length means "all done" */
  index: number;
  labels: string[];
  current: string;
  onBack?: () => void;
  doneText?: string;
  backLabel?: string;
}) {
  const n = labels.length;
  const done = index >= n;
  return (
    <div className="bg-surface mb-5 rounded-2xl px-2 pt-2 pb-3">
      <div className="flex min-h-11 items-center gap-1">
        {index > 0 && onBack && (
          <button
            type="button"
            onClick={onBack}
            className="text-brand-700 hover:bg-surface-2 inline-flex min-h-11 min-w-11 items-center gap-1 rounded-[10px] px-2 text-small font-semibold"
          >
            <Icon name="back" size={18} />
            {backLabel}
          </button>
        )}
        <span className="text-ink ps-2 text-small font-extrabold">{current}</span>
        <span className="text-ink-muted ms-auto pe-2 text-caption font-semibold">
          {done ? (doneText ?? `هر ${fa(n)} مرحله انجام شد`) : `مرحله ${fa(index + 1)} از ${fa(n)}`}
        </span>
      </div>
      <div
        className="nf-progress px-2 pt-1"
        role="progressbar"
        aria-label="پیشرفت"
        aria-valuemin={1}
        aria-valuemax={n}
        aria-valuenow={Math.min(index + 1, n)}
        style={{ ['--steps' as string]: n }}
      >
        {labels.map((l, k) => (
          <span key={l} className={k < index ? 'is-done' : k === index ? 'is-current' : ''} />
        ))}
      </div>
      <div className="text-ink-faint grid gap-1.5 px-2 pt-1.5 text-caption font-semibold" style={{ gridTemplateColumns: `repeat(${n},1fr)` }} aria-hidden="true">
        {labels.map((l, k) => (
          <span key={l} className={k <= index ? 'text-brand-700' : ''}>
            {l}
          </span>
        ))}
      </div>
    </div>
  );
}

/** Option tile: one tap selects (aria-pressed) and the caller advances after ~180ms. */
export function OptionTile({
  icon,
  title,
  hint,
  pressed,
  onSelect,
}: {
  icon: Parameters<typeof Icon>[0]['name'];
  title: string;
  hint?: string;
  pressed: boolean;
  onSelect: () => void;
}) {
  return (
    <button type="button" className="nf-option group" aria-pressed={pressed} onClick={onSelect}>
      <span
        className={`grid size-11 shrink-0 place-items-center rounded-xl ${pressed ? 'bg-brand-600 text-white' : 'bg-brand-50 text-brand-600'}`}
      >
        <Icon name={icon} />
      </span>
      <span className="grid flex-1 leading-relaxed">
        <b className="text-[17px] font-extrabold">{title}</b>
        {hint && <small className="text-ink-muted text-caption">{hint}</small>}
      </span>
      <Icon name="chev" className={pressed ? 'text-brand-600' : 'text-ink-faint'} />
    </button>
  );
}
