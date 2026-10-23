/** React primitives for islands — same look as the Astro ones (see styles.ts). */
import { forwardRef, useId, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from 'react';
import { buttonClass, inputClass, labelClass, cardClass, type ButtonSize, type ButtonVariant } from './styles';

export function Button({
  variant = 'primary',
  size = 'md',
  className = '',
  ...p
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ButtonSize }) {
  return <button type="button" className={buttonClass(variant, size, className)} {...p} />;
}

export function Card({ className = '', children }: { className?: string; children: ReactNode }) {
  return <div className={`${cardClass} p-5 sm:p-6 ${className}`}>{children}</div>;
}

type InputProps = InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  hint?: string;
  error?: string | null;
  suffix?: ReactNode;
};
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, hint, error, suffix, id, className = '', ...p },
  ref,
) {
  const auto = useId();
  const inputId = id ?? auto;
  const describedBy = error ? `${inputId}-err` : hint ? `${inputId}-hint` : undefined;
  return (
    <div className={className}>
      <label htmlFor={inputId} className={labelClass}>
        {label}
      </label>
      <div className="relative">
        <input
          ref={ref}
          id={inputId}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={`${inputClass} ${suffix ? 'pl-16' : ''}`}
          {...p}
        />
        {suffix && (
          <span className="text-ink-muted pointer-events-none absolute inset-y-0 left-4 flex items-center text-sm">
            {suffix}
          </span>
        )}
      </div>
      {error ? (
        <p id={`${inputId}-err`} className="text-danger mt-1.5 text-sm font-semibold">
          {error}
        </p>
      ) : hint ? (
        <p id={`${inputId}-hint`} className="text-ink-muted mt-1.5 text-sm">
          {hint}
        </p>
      ) : null}
    </div>
  );
});

/** Big tappable radio cards — preferred over <select> on mobile. */
export function ChoiceGroup<T extends string>({
  label,
  value,
  options,
  onChange,
  name,
}: {
  label: string;
  name: string;
  value: T | '';
  options: { value: T; label: string; hint?: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <fieldset>
      <legend className={labelClass}>{label}</legend>
      <div className="grid gap-2.5 sm:grid-cols-2">
        {options.map((o) => (
          <label
            key={o.value}
            className={`flex min-h-14 cursor-pointer items-center gap-3 rounded-[var(--radius)] border px-4 py-3 transition-colors ${value === o.value ? 'border-brand-500 bg-brand-50 ring-brand-100 ring-4' : 'border-line hover:border-brand-200 bg-white'}`}
          >
            <input
              type="radio"
              name={name}
              value={o.value}
              checked={value === o.value}
              onChange={() => onChange(o.value)}
              className="accent-brand-600 size-5"
            />
            <span>
              <span className="text-ink block font-semibold">{o.label}</span>
              {o.hint && <span className="text-ink-muted block text-sm">{o.hint}</span>}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
