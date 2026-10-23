/** Shared class recipes so Astro (zero-JS) and React (island) primitives look identical. */
export type ButtonVariant = 'primary' | 'gold' | 'secondary' | 'ghost';
export type ButtonSize = 'md' | 'lg';

const base =
  'inline-flex items-center justify-center gap-2 rounded-[var(--radius)] font-bold leading-tight transition-[background,box-shadow,border-color,transform] active:scale-[.98] disabled:pointer-events-none disabled:opacity-55 select-none whitespace-nowrap';
const variants: Record<ButtonVariant, string> = {
  primary:
    'bg-brand-600 text-white shadow-[0_1px_2px_rgba(23,41,80,.12),0_4px_12px_-4px_rgba(28,54,135,.35)] hover:bg-brand-700',
  gold: 'bg-gold-500 text-white shadow-[0_4px_12px_-4px_rgba(138,106,53,.45)] hover:bg-gold-700',
  secondary: 'border border-line bg-white text-ink hover:bg-surface-2',
  ghost: 'text-ink-soft hover:bg-surface-2 hover:text-ink',
};
const sizes: Record<ButtonSize, string> = {
  md: 'min-h-12 px-5 text-[15px]', // 48px
  lg: 'min-h-14 px-7 text-[17px]', // 56px hero CTAs
};
export const buttonClass = (variant: ButtonVariant = 'primary', size: ButtonSize = 'md', extra = '') =>
  [base, variants[variant], sizes[size], extra].filter(Boolean).join(' ');

export const inputClass =
  'block w-full min-h-12 rounded-[var(--radius)] border border-line bg-white px-4 text-base text-ink placeholder:text-ink-faint transition-[border-color,box-shadow] hover:border-brand-200 focus:border-brand-500 focus:outline-none focus:ring-4 focus:ring-brand-100 aria-[invalid=true]:border-danger';
export const labelClass = 'mb-2 block text-[15px] font-semibold text-ink-soft';
export const cardClass = 'rounded-[var(--radius-xl)] border border-line bg-white shadow-card';
