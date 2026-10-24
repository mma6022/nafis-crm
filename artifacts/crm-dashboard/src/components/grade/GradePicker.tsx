import { AlertCircle, Check } from 'lucide-react';
import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import {
  GRADE_COLORS, GRADE_LETTERS, LEGACY_LABEL, SUB_LEVELS, faDigits, gradeBg, gradeLetter, isLegacy, isSubgrade, normalizeGrade,
  stepIndex, subgradesOf, typedLetter, typedLevel, type GradeLetter,
} from '@/lib/credit-grade';
import { GradeChip } from './GradeChip';
import './grade.css';

const letterVars = (l: GradeLetter): CSSProperties => ({ ['--gm' as string]: GRADE_COLORS[l].main, ['--gt' as string]: GRADE_COLORS[l].text, ['--gb' as string]: GRADE_COLORS[l].bg2 });
const subVars = (g: string): CSSProperties => ({ ['--gm' as string]: GRADE_COLORS[g[0] as GradeLetter].main, ['--gt' as string]: GRADE_COLORS[g[0] as GradeLetter].text, ['--gb' as string]: gradeBg(g) });
const Tick = () => <Check className="cgp-tick" aria-hidden="true" strokeWidth={3} />;
const Ltr = ({ children }: { children: ReactNode }) => <span className="cgp-ltr" dir="ltr">{children}</span>;

/** Moves focus inside a row of buttons (roving tabindex); RTL: → goes toward A / 1, ← toward E / 3. */
function rowKey(e: KeyboardEvent<HTMLElement>, refs: Array<HTMLButtonElement | null>, index: number): boolean {
  const delta = e.key === 'ArrowRight' ? -1 : e.key === 'ArrowLeft' ? 1 : e.key === 'Home' ? -99 : e.key === 'End' ? 99 : 0;
  if (!delta) return false;
  e.preventDefault();
  const count = refs.length;
  const next = Math.abs(delta) === 99 ? (delta < 0 ? 0 : count - 1) : stepIndex(index, delta, count);
  refs[next]?.focus();
  return true;
}

export type GradePickerProps = {
  label: string; value: string; onChange: (value: string, pending: boolean) => void;
  /** Value stored before this edit; a legacy letter there is kept when untouched (PM decision 4). */
  original?: string | null;
  required?: boolean; disabled?: boolean; readOnly?: boolean;
  /** Show validation (after a save attempt). */
  showError?: boolean; error?: string;
  emptyError?: string; testId?: string; id?: string; children?: ReactNode;
  /** Label stays for screen readers only (the page heading already asks the question). */
  hideLabel?: boolean;
};

/** Two-row credit grade picker: row 1 letter (A on the right), row 2 that letter's sub-grades. */
export function GradePicker({ label, value, onChange, original, required, disabled, readOnly, showError, error, emptyError, testId = 'grade', id, children, hideLabel }: GradePickerProps) {
  const auto = useId();
  const base = id ?? `cgp${auto.replace(/[^a-zA-Z0-9]/g, '')}`;
  const v = normalizeGrade(value);
  const orig = normalizeGrade(original);
  const origLegacy = isLegacy(orig) ? (orig as GradeLetter) : null;
  const [letter, setLetter] = useState<GradeLetter | null>(() => gradeLetter(v));
  const [typed, setTyped] = useState('');
  const emitted = useRef<string>(v);
  const letterRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const subRefs = useRef<Array<HTMLButtonElement | null>>([]);
  useEffect(() => { // follow outside resets, not our own pending state
    if (v === emitted.current) return;
    emitted.current = v; setLetter(gradeLetter(v)); setTyped('');
  }, [v]);
  const emit = (next: string, pending: boolean) => { emitted.current = next; onChange(next, pending); };
  const legacyMode = isLegacy(v) && letter === v;
  const pending = !!letter && !v;
  const focusSub = (lv?: number) => requestAnimationFrame(() => subRefs.current[(lv ?? (isSubgrade(v) && v[0] === letter ? Number(v[1]) : 1)) - 1]?.focus());

  const pickLetter = (l: GradeLetter, focus = true) => {
    if (l !== letter) {
      setLetter(l);
      if (origLegacy === l) emit(origLegacy, false); else emit('', true);
    }
    if (focus) focusSub(l === letter && isSubgrade(v) ? Number(v[1]) : 1);
  };
  const pickSub = (lv: number) => { if (letter) emit(`${letter}${lv}`, false); };
  const restore = () => { if (!origLegacy) return; setLetter(origLegacy); emit(origLegacy, false); setTyped(''); };
  const clear = () => {
    setTyped('');
    if (origLegacy) restore(); else { setLetter(null); emit('', false); }
    requestAnimationFrame(() => letterRefs.current[0]?.focus());
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (disabled || e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === 'Backspace') { e.preventDefault(); clear(); return; }
    const l = typedLetter(e.key);
    if (l) { e.preventDefault(); setTyped(e.key.toLowerCase()); pickLetter(l); return; }
    const lv = typedLevel(e.key);
    if (lv && letter) { e.preventDefault(); setTyped((t) => (t ? `${t}${e.key}` : e.key)); pickSub(lv); requestAnimationFrame(() => subRefs.current[lv - 1]?.focus()); }
  };

  const labelId = `${base}-label`;
  if (readOnly) return <div className="cgp-readonly" role="group" aria-labelledby={labelId} data-testid={`${testId}-readonly`}><p className="cgp-title" id={labelId}>{label}</p><GradeChip value={v} size="lg" /></div>;

  const rowState = !letter ? 'is-empty' : legacyMode ? 'is-legacy' : isSubgrade(v) ? 'is-done' : 'is-pending';
  const subBad = pending && (showError || !!origLegacy);
  const missingBad = showError && required && !letter;
  const letterTab = GRADE_LETTERS.indexOf(letter ?? 'A');
  const subTab = isSubgrade(v) && v[0] === letter ? Number(v[1]) - 1 : 0;
  const errId = `${base}-err`;
  let message: ReactNode = null;
  if (error) message = error;
  else if (pending && origLegacy) message = <>برای ذخیره، زیررتبه‌ی <Ltr>{letter}</Ltr> لازم است.</>;
  else if (pending && showError) message = <>زیررتبه‌ی <Ltr>{letter}</Ltr> را انتخاب کنید.</>;
  else if (missingBad) message = emptyError ?? 'رتبه اعتبارسنجی را انتخاب کنید.';

  return <div className={`cgp${disabled ? ' is-disabled' : ''}`} role="group" aria-labelledby={labelId} aria-describedby={message ? errId : undefined} onKeyDown={onKeyDown} data-testid={testId}>
    <p className={`cgp-title${hideLabel ? ' cgp-sr' : ''}`} id={labelId}>{label}{required ? <span className="req" aria-hidden="true">*</span> : null}</p>
    {origLegacy && legacyMode ? <p className="cgp-note is-amber" data-testid={`${testId}-legacy-note`}>رتبه‌ی فعلی <Ltr>{origLegacy}</Ltr> ({LEGACY_LABEL}) است و اگر تغییرش ندهید، همین‌طور ذخیره می‌شود. برای تکمیل، زیررتبه را بزنید.</p> : null}
    {origLegacy && !legacyMode && letter ? <p className="cgp-note is-blue" role="status" data-testid={`${testId}-change-note`}>
      رتبه از <Ltr>{origLegacy}</Ltr> ({LEGACY_LABEL}) به <Ltr>{isSubgrade(v) ? v : letter}</Ltr> {isSubgrade(v) ? 'تغییر می‌کند.' : 'تغییر کرد.'}
      <button type="button" className="cgp-link" onClick={restore} data-testid={`${testId}-restore`}>بازگرداندن به {origLegacy} {LEGACY_LABEL}</button></p> : null}
    <div className="cgp-row">
      <p className="cgp-row-label" id={`${base}-l1`}>۱. حرف</p>
      <div className="cgp-btns" role="radiogroup" aria-label="حرف رتبه">
        {GRADE_LETTERS.map((l, i) => {
          const on = letter === l && !legacyMode, old = legacyMode && letter === l;
          return <button key={l} ref={(el) => { letterRefs.current[i] = el; }} type="button" role="radio" aria-checked={letter === l}
            aria-label={old ? `${l} (${LEGACY_LABEL})` : l} tabIndex={i === letterTab ? 0 : -1} disabled={disabled}
            className={`cgp-btn${on ? ' is-on' : ''}${old ? ' is-legacy' : ''}`} style={letterVars(l)}
            onClick={() => pickLetter(l)} onKeyDown={(e) => { if (!rowKey(e, letterRefs.current, i) && e.key === 'ArrowDown' && letter) { e.preventDefault(); focusSub(); } }}
            data-testid={`${testId}-letter-${l}`}>
            {old ? <span className="cgp-tag" aria-hidden="true">{LEGACY_LABEL}</span> : null}{on ? <Tick /> : null}{l}
          </button>;
        })}
      </div>
    </div>
    <div className="cgp-row">
      <p className="cgp-row-label" id={`${base}-l2`}>۲. زیررتبه {letter ? <Ltr>{letter}</Ltr> : null}</p>
      <div className={`cgp-btns cgp-sub ${rowState}${subBad ? ' is-bad' : ''}`} role="radiogroup" aria-label="زیررتبه" aria-disabled={!letter || undefined} aria-invalid={subBad || undefined}>
        {SUB_LEVELS.map((n, i) => {
          const g = letter ? `${letter}${n}` : '';
          const on = !!g && v === g;
          return <button key={n} ref={(el) => { subRefs.current[i] = el; }} type="button" role="radio" aria-checked={on} aria-label={g || faDigits(n)}
            tabIndex={letter && i === subTab ? 0 : -1} disabled={disabled || !letter} className={`cgp-btn${on ? ' is-on' : ''}`} style={g ? subVars(g) : undefined}
            onClick={() => pickSub(i + 1)} onKeyDown={(e) => { if (!rowKey(e, subRefs.current, i) && e.key === 'ArrowUp') { e.preventDefault(); letterRefs.current[letterTab]?.focus(); } }}
            data-testid={`${testId}-sub-${n}`}>
            {on ? <Tick /> : null}{g || faDigits(n)}
          </button>;
        })}
      </div>
      {!letter && !message ? <p className="cgp-hint">اول حرف را انتخاب کنید.</p> : null}
    </div>
    {typed && !disabled ? <p className="cgp-typed" aria-hidden="true">تایپ شد <kbd>{typed}</kbd>{pending ? <> ← حالا <kbd>1</kbd><kbd>2</kbd><kbd>3</kbd></> : null}</p> : null}
    {message ? <p className="cgp-err" id={errId} role="alert" data-testid={`${testId}-error`}><AlertCircle size={14} aria-hidden="true" />{message}</p> : null}
    {children}
  </div>;
}

/** Multi-select for plan conditions (shot 10): letters are checkboxes (full / ۲/۳ partial), row 2 the open letter's sub-grades + «همه‌ی X». */
export function GradePickerMulti({ label, values, onChange, disabled, testId = 'grades', note }: { label: string; values: string[]; onChange: (values: string[]) => void; disabled?: boolean; testId?: string; note?: ReactNode }) {
  const auto = useId();
  const labelId = `gpm${auto.replace(/[^a-zA-Z0-9]/g, '')}`;
  const selected = values.map(normalizeGrade).filter(isSubgrade);
  const [open, setOpen] = useState<GradeLetter>(() => (gradeLetter(selected[0]) ?? 'A'));
  const letterRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const subRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const others = values.filter((x) => !isSubgrade(x)); // non-grade values (if any) are kept as they are
  const order = (list: string[]) => [...[...new Set(list)].sort((a, b) => CREDIT_INDEX(a) - CREDIT_INDEX(b)), ...others];
  const toggle = (g: string) => onChange(order(selected.includes(g) ? selected.filter((x) => x !== g) : [...selected, g]));
  const subs = subgradesOf(open);
  const allOn = subs.every((g) => selected.includes(g));
  const toggleAll = () => onChange(order(allOn ? selected.filter((g) => !subs.includes(g)) : [...selected, ...subs]));
  const openTab = GRADE_LETTERS.indexOf(open);
  return <div className={`cgp${disabled ? ' is-disabled' : ''}`} role="group" aria-labelledby={labelId} data-testid={testId}>
    <p className="cgp-title" id={labelId}>{label}</p>
    {note ? <p className="cgp-note is-blue" data-testid={`${testId}-converted-note`}>{note}</p> : null}
    <div className="cgp-row">
      <p className="cgp-row-label">۱. حرف</p>
      <div className="cgp-btns" role="group" aria-label="حرف رتبه">
        {GRADE_LETTERS.map((l, i) => {
          const n = subgradesOf(l).filter((g) => selected.includes(g)).length;
          const full = n === 3, part = n > 0 && n < 3;
          return <button key={l} ref={(el) => { letterRefs.current[i] = el; }} type="button" role="checkbox" aria-checked={full ? true : part ? 'mixed' : false}
            aria-expanded={open === l} aria-label={part ? `${l} (${faDigits(n)} از ۳)` : l} tabIndex={i === openTab ? 0 : -1} disabled={disabled}
            className={`cgp-btn${full ? ' is-on' : ''}${part ? ' is-partial' : ''}${open === l && !full ? ' is-open' : ''}`} style={letterVars(l)}
            onClick={() => { setOpen(l); requestAnimationFrame(() => subRefs.current[0]?.focus()); }}
            onKeyDown={(e) => { if (!rowKey(e, letterRefs.current, i) && e.key === 'ArrowDown') { e.preventDefault(); subRefs.current[0]?.focus(); } }}
            data-testid={`${testId}-letter-${l}`}>
            {part ? <span className="cgp-badge" aria-hidden="true">{faDigits(n)}/۳</span> : null}{full ? <Tick /> : null}{l}
          </button>;
        })}
      </div>
    </div>
    <div className="cgp-row">
      <p className="cgp-row-label">۲. زیررتبه <Ltr>{open}</Ltr></p>
      <div className="cgp-btns cgp-sub is-done" role="group" aria-label="زیررتبه">
        {subs.map((g, i) => {
          const on = selected.includes(g);
          return <button key={g} ref={(el) => { subRefs.current[i] = el; }} type="button" role="checkbox" aria-checked={on} tabIndex={i === 0 ? 0 : -1} disabled={disabled}
            className={`cgp-btn${on ? ' is-on' : ''}`} style={subVars(g)} onClick={() => toggle(g)}
            onKeyDown={(e) => { if (!rowKey(e, [...subRefs.current], i) && e.key === 'ArrowUp') { e.preventDefault(); letterRefs.current[openTab]?.focus(); } }}
            data-testid={`${testId}-sub-${g}`}>{on ? <Tick /> : null}{g}</button>;
        })}
        <button type="button" ref={(el) => { subRefs.current[3] = el; }} tabIndex={-1} role="checkbox" aria-checked={allOn} disabled={disabled}
          className={`cgp-btn cgp-all${allOn ? ' is-on' : ''}`} onClick={toggleAll}
          onKeyDown={(e) => { if (!rowKey(e, [...subRefs.current], 3) && e.key === 'ArrowUp') { e.preventDefault(); letterRefs.current[openTab]?.focus(); } }}
          data-testid={`${testId}-all-${open}`}>{allOn ? <Tick /> : null}همه‌ی&nbsp;<Ltr>{open}</Ltr></button>
      </div>
    </div>
    <div className="cgp-picked" data-testid={`${testId}-picked`}><span className="cgp-picked-title">انتخاب‌شده ({faDigits(selected.length)})</span>
      {selected.length ? selected.map((g) => <GradeChip key={g} value={g} />) : <span className="cgp-hint">هیچ رتبه‌ای انتخاب نشده؛ یعنی محدودیت رتبه ندارد.</span>}</div>
  </div>;
}
const CREDIT_INDEX = (g: string) => GRADE_LETTERS.indexOf(g[0] as GradeLetter) * 3 + Number(g[1]);
