/**
 * Plan finder island (designer site.js `mountFinder`, UX-SPEC §4). 2 one-tap questions (amount, priority; the old
 * cash/goods question was removed for legal reasons 2026-10-24, every eligible plan is considered) (+ «بازنشسته هستم» toggle: retiree-only plans need it) (fewer when a page preset
 * answers one) → 1 featured card + up to 2 alternatives. Never "no plan found": recommend() relaxes.
 * Starts on the build-time snapshot, then swaps to the live /data/loan-plans.json.
 * Deep link (first finder on the page only): ?a=band,prio → result; add &step=band|prio to open a step. Old 3-part
 * links (?a=cash,2,fast) still work: the leading type part is ignored.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { LoanPlan } from '../../lib/loan-plans';
import {
  FINDER_LABEL,
  FINDER_PRIOS,
  FINDER_Q,
  combos,
  fa,
  recommend,
  type FinderAnswers,
  type FinderBand,
  type FinderPreset,
  type FinderPrio,
  withoutUnbackedGuarantee,
} from '../../lib/plans';

import { parseDeepLink, type FinderDeepLink } from '../../lib/request-flow';
import { useLoanPlans } from './useLoanPlans';
import { LONG_NAME, PlanCard, QA } from './PlanCard';
import CallbackForm from './CallbackForm';
import { I, type SpriteIcon } from '../ui/I';

type Key = 'band' | 'prio';
type Step = Key | 'result';
type Ans = FinderDeepLink;

declare global {
  interface Window {
    __finderDeep?: boolean;
  }
}

export default function PlanFinder({
  snapshot,
  preset: rawPreset,
  src = 'finder',
  id,
  titleTag = 'h3',
}: {
  snapshot: LoanPlan[];
  preset?: FinderPreset;
  src?: string;
  id?: string;
  titleTag?: 'h2' | 'h3';
}) {
  const { plans } = useLoanPlans(snapshot);
  const all = useMemo(() => combos(plans), [plans]);
  // A guarantee preset («بدون ضامن» …) is a claim the data can't back until plans carry guaranteeTypes:
  // drop its chip, note and ranking effect until then (ANSWERS-1 §9).
  const preset = useMemo(() => withoutUnbackedGuarantee(rawPreset, all), [rawPreset, all]);
  const fixed: Ans = useMemo(() => (preset?.prio ? { prio: preset.prio } : {}), [preset]);
  const keys = (['band', 'prio'] as Key[]).filter((k) => !(k in fixed));
  const N = keys.length;
  const ORDER: Step[] = [...keys, 'result'];
  const [ans, setAns] = useState<Ans>(fixed);
  const [step, setStep] = useState<Step>(ORDER[0]!);
  const [longName, setLongName] = useState(false);
  const [retired, setRetired] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const focusNext = useRef(false);
  const T = titleTag;

  useEffect(() => {
    const q = new URLSearchParams(location.search);
    if (QA && q.get('longname')) setLongName(true);
    if (window.__finderDeep || !q.get('a')) return;
    window.__finderDeep = true;
    setAns({ ...parseDeepLink(q.get('a')), ...fixed });
    const s = q.get('step') as Step | null; // a legacy &step=type is not in ORDER → result
    const got = { ...parseDeepLink(q.get('a')), ...fixed };
    const missing = keys.find((k) => got[k] === undefined);
    setStep(s && ORDER.includes(s) ? s : (missing ?? 'result'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!focusNext.current) return;
    focusNext.current = false;
    root.current?.querySelector<HTMLElement>(`[data-step="${step}"] .q-title`)?.focus({ preventScroll: true });
  }, [step]);

  const go = (s: Step) => {
    focusNext.current = true;
    setStep(s);
  };
  const i = ORDER.indexOf(step);
  const complete = ans.band !== undefined && ans.prio !== undefined;
  const r = useMemo(() => (step === 'result' && complete ? recommend(all, { ...(ans as FinderAnswers), retired }, preset) : null), [step, complete, all, ans, preset, retired]);
  // home: hides the #callback section so only one callback form is open (CALLBACK-HANDOFF.md)
  useEffect(() => {
    if (r) root.current?.dispatchEvent(new CustomEvent('finder:result', { bubbles: true }));
  }, [r]);

  const pick = (k: Key, v: string | number) => {
    setAns((p) => ({ ...p, [k]: v }));
    const next = ORDER[i + 1]!;
    setTimeout(() => go(next), 180);
  };
  const presetChips = [
    preset?.prio && FINDER_LABEL.prio[preset.prio],
    preset?.guarantee?.label,
  ].filter(Boolean) as string[];

  return (
    <div className="panel" ref={root} id={id}>
      <div className="stepbar">
        <div className="top">
          <button type="button" className="back" hidden={i === 0} onClick={() => go(ORDER[i - 1]!)}>
            <I name="back" size={18} />
            قبلی
          </button>
          <span className="cur">{step === 'result' ? 'نتیجه' : FINDER_Q[step].step}</span>
          <span className="count">{step === 'result' ? `هر ${fa(N)} مرحله انجام شد` : `مرحله ${fa(i + 1)} از ${fa(N)}`}</span>
        </div>
        <div
          className="nf-progress"
          role="progressbar"
          aria-label="پیشرفت طرح‌یاب"
          aria-valuemin={1}
          aria-valuemax={N}
          aria-valuenow={Math.min(i + 1, N)}
          style={{ ['--steps' as string]: N }}
        >
          {keys.map((k, n) => (
            <span key={k} className={n < i ? 'is-done' : n === i ? 'is-current' : ''} />
          ))}
        </div>
        <div className="labels" style={{ gridTemplateColumns: `repeat(${N},1fr)` }}>
          {keys.map((k, n) => (
            <span key={k} className={n <= i ? 'on' : ''}>
              {FINDER_Q[k].lbl}
            </span>
          ))}
        </div>
      </div>
      {presetChips.length > 0 && (
        <p className="preset-note">
          از قبل در نظر گرفته‌ایم:{' '}
          {presetChips.map((c) => (
            <span className="chip" key={c}>
              {c}
            </span>
          ))}
        </p>
      )}
      {keys.map((k) => (
        <div className="step" data-step={k} hidden={step !== k} key={k}>
          <T className="q-title" tabIndex={-1}>
            {FINDER_Q[k].title}
          </T>
          <p className="q-hint">{FINDER_Q[k].hint}</p>
          <div className="opts" role="group" aria-label={FINDER_Q[k].step}>
            {FINDER_Q[k].opts.map((o) => (
              <button type="button" className="nf-option" key={o.v} aria-pressed={ans[k] === o.v} onClick={() => pick(k, o.v)}>
                <span className="ic">
                  <I name={o.icon as SpriteIcon} />
                </span>
                <span className="tx">
                  <b>{o.title}</b>
                  {o.sub && <small>{o.sub}</small>}
                </span>
                <I name="chev" className="chev" />
              </button>
            ))}
          </div>
        </div>
      ))}
      <div className="step" data-step="result" hidden={step !== 'result'} aria-live="polite">
        <T className="q-title res-title" tabIndex={-1}>
          {r && !r.exact ? 'نزدیک‌ترین گزینه‌ها برای شما' : 'طرح پیشنهادی شما'}
        </T>
        {r && (
          <>
            <div className="answers">
              {[FINDER_LABEL.band[ans.band!], FINDER_LABEL.prio[ans.prio!]].map((t) => (
                <span className="chip" key={t}>
                  {t}
                </span>
              ))}
              <button type="button" className="chip-link" onClick={() => go(ORDER[0]!)}>
                تغییر پاسخ‌ها
              </button>
            </div>
            <label className="retired-toggle">
              <input type="checkbox" checked={retired} onChange={(e) => setRetired(e.currentTarget.checked)} />
              <span>بازنشسته هستم</span>
            </label>
            {!r.cards.length && (
              <p className="plan-note">در حال حاضر طرحی با این شرط‌ها نداریم. شماره‌تان را بگذارید تا کارشناس نزدیک‌ترین راه را بگوید.</p>
            )}
            <div className={`cards n${r.cards.length}`}>
              {r.cards.map((c, k) => (
                <PlanCard
                  key={`${c.id}-${c.term}`}
                  c={c}
                  featured={k === 0}
                  variant="result"
                  src={src}
                  name={longName && k === 0 ? LONG_NAME : undefined}
                />
              ))}
            </div>
          </>
        )}
        <div className="res-foot">
          {r && (
            <div className="help cb-mount">
              {/* secondary: the featured plan card owns the page's primary button (CALLBACK-HANDOFF.md) */}
              <CallbackForm
                key={`${ans.band}-${ans.prio}-${retired}`}
                variant="inline"
                src={`${src}-result`}
                planId={r.cards[0]?.id ?? null}
                titleTag="h3"
              />
            </div>
          )}
          <div className="all-link">
            <a className="nf-btn nf-btn--text" href="/plans/">
              دیدن همه طرح‌ها
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
