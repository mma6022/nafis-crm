/**
 * Shared class recipes so Astro (zero-JS) and React (island) primitives look identical.
 * Values follow /workspace/nafis-design/DESIGN-SYSTEM.md (tokens in styles/design/tailwind-theme.css).
 */
export type ButtonVariant = 'primary' | 'gold' | 'secondary' | 'soft' | 'ghost' | 'text';
export type ButtonSize = 'sm' | 'md' | 'lg';

const base =
  'inline-flex items-center justify-center gap-2 rounded-control font-extrabold leading-snug transition-[background,box-shadow,border-color,transform] duration-150 ease-nf active:scale-[.98] disabled:pointer-events-none disabled:opacity-50 select-none whitespace-nowrap';
const variants: Record<ButtonVariant, string> = {
  /** One per screen. White on logo indigo (9.8:1). */
  primary: 'bg-brand-600 text-white shadow-button hover:bg-brand-700',
  /** Accent: sticky bar «درخواست وام» only. Text on gold is always navy (#0B1450, 9.9:1), never white. */
  gold: 'bg-gold-400 text-brand-900 hover:bg-gold-500',
  secondary: 'border-[1.5px] border-brand-200 bg-white text-brand-700 hover:border-brand-300 hover:bg-brand-50',
  /** Header CTA: soft indigo, so the hero keeps a single primary. */
  soft: 'border-[1.5px] border-brand-100 bg-brand-50 text-brand-700 hover:bg-brand-100',
  ghost: 'text-ink-soft hover:bg-surface-2 hover:text-ink',
  text: 'min-h-11 px-2 text-brand-600 underline underline-offset-[6px] decoration-brand-200 hover:decoration-brand-400',
};
const sizes: Record<ButtonSize, string> = {
  sm: 'min-h-control-sm px-4 text-small', // 44px header CTA
  md: 'min-h-control px-6 text-body', // 52px default
  lg: 'min-h-control px-7 text-body lg:min-h-14 lg:text-[17px]',
};
export const buttonClass = (variant: ButtonVariant = 'primary', size: ButtonSize = 'md', extra = '') =>
  [base, variants[variant], variant === 'text' ? 'text-body' : sizes[size], extra].filter(Boolean).join(' ');

export const inputClass =
  'block w-full min-h-control rounded-control border-[1.5px] border-line-strong bg-white px-4 text-body text-ink placeholder:text-ink-faint transition-[border-color,box-shadow] hover:border-brand-300 focus:border-brand-600 focus:outline-none focus:shadow-[0_0_0_4px_rgba(41,55,160,.22)] aria-[invalid=true]:border-danger';
export const labelClass = 'mb-2 block text-small font-semibold text-ink';
export const cardClass = 'rounded-card border border-line bg-white shadow-card';
/** Option tile: finder and wizard answers (64px or more, one tap selects). */
export const optionClass =
  'flex w-full min-h-option items-center gap-3.5 rounded-control border-[1.5px] border-line-strong bg-white px-4 py-3 text-start text-ink transition-[border-color,background] duration-150 hover:border-brand-300 aria-pressed:border-brand-600 aria-pressed:bg-brand-50 aria-checked:border-brand-600 aria-checked:bg-brand-50';
