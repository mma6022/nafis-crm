/**
 * «درخواست مشاوره‌ی رایگان» callback form (designer CALLBACK-HANDOFF.md §1; behaviour = mockups/src/site.js
 * `mountCallback`, markup/classes = mockups/src/site.css «Callback» block).
 * Variants: 'section' (home / landings / contact), 'inline' (under the finder result: collapsed first, secondary),
 * 'sheet' (header / mobile-menu <dialog>, see CallbackDialog). Two steps + progress bar: name + mobile → contact
 * time (radio tiles, required) + topic (chips, optional) + consent. «همین الان» only inside working hours
 * (Asia/Tehran via Intl, lib/callback). POST kind=callback to PUBLIC_LEAD_ENDPOINT with honeypot + startedAt.
 * Success only on 2xx; the tracking code line only when the CRM returned one (a duplicate shows the same screen).
 * The site never promises a number of minutes.
 */
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { I } from '../ui/I';
import { fa } from '../../lib/plans';
import { normalizeIranMobile } from '../../lib/format';
import { LeadError, readUtm, type Need } from '../../lib/lead';
import { CALLBACK_WHATSAPP, MESSENGERS, SITE, WORK_HOURS } from '../../lib/site';
import {
  CB_DONE,
  CB_SUBMIT,
  CB_TITLE,
  TOPIC_OPTS,
  faMobile,
  isWorkingHours,
  step1Errors,
  step2Errors,
  submitCallback,
  successLine,
  timeOptions,
  type CallbackTime,
  type FieldError,
} from '../../lib/callback';

export type CallbackVariant = 'section' | 'inline' | 'sheet';
type Step = 1 | 2 | 3;

const LEAD_SECTION = 'شماره‌تان را بگذارید؛ کارشناس نفیس وام تماس می‌گیرد و رایگان راهنمایی‌تان می‌کند.';
const LEAD_INLINE = 'مطمئن نیستید؟ نام و شماره‌تان را بگذارید؛ کارشناس نفیس وام درباره همین طرح‌ها رایگان راهنمایی‌تان می‌کند.';

export default function CallbackForm({
  variant = 'section',
  src = 'page',
  topic: topic0 = null,
  planId = null,
  title = CB_TITLE,
  lead,
  wa = false,
  primary = variant !== 'inline',
  titleTag = 'h2',
  autoFocus = false,
}: {
  variant?: CallbackVariant;
  src?: string;
  /** preselected topic (finder answer) */
  topic?: Need | null;
  planId?: number | null;
  title?: string;
  lead?: string;
  /** home only: «یا در واتساپ بپرسید» (shown only when CALLBACK_WHATSAPP is set) */
  wa?: boolean;
  primary?: boolean;
  titleTag?: 'h2' | 'h3';
  /** sheet only: the dialog opener focuses the name field (handoff); never on page load */
  autoFocus?: boolean;
}) {
  const id = useId().replace(/:/g, '');
  const H = titleTag;
  const btn = primary ? 'nf-btn--primary' : 'nf-btn--secondary';
  const [open, setOpen] = useState(variant !== 'inline');
  const [step, setStep] = useState<Step>(1);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [norm, setNorm] = useState('');
  const [time, setTime] = useState<CallbackTime | null>(null);
  const [topic, setTopic] = useState<Need | null>(topic0);
  const [consent, setConsent] = useState(false);
  const [err, setErr] = useState<Partial<Record<FieldError, boolean>>>({});
  const [busy, setBusy] = useState(false);
  const [fail, setFail] = useState(false);
  const [code, setCode] = useState<string | undefined>();
  const [when, setWhen] = useState('');
  // Built ahead of time: hours are evaluated in the browser after hydration, then every minute.
  const [inHours, setInHours] = useState(false);
  const startedAt = useRef(Date.now());
  const honeypot = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const failRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const tick = () => setInHours(isWorkingHours());
    tick();
    const t = setInterval(tick, 60_000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => setTopic(topic0), [topic0]);
  useEffect(() => {
    if (!inHours && time === 'now') setTime(null);
  }, [inHours, time]);

  const q = <T extends HTMLElement>(sel: string) => root.current?.querySelector<T>(sel) ?? null;
  const focusLater = (sel: string) => requestAnimationFrame(() => q(sel)?.focus({ preventScroll: false }));

  function go(s: Step, focus = true) {
    setStep(s);
    setFail(false);
    if (focus) focusLater(s === 1 ? `#${id}-n` : s === 2 ? '[data-time]' : '.cb-done');
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (step === 1) {
      const bad = step1Errors(name, phone);
      setErr({ name: bad.includes('name'), phone: bad.includes('phone') });
      if (bad.length) {
        q<HTMLInputElement>(bad[0] === 'name' ? `#${id}-n` : `#${id}-m`)?.focus();
        return;
      }
      const n = normalizeIranMobile(phone)!;
      setNorm(n);
      setPhone(faMobile(n)); // show the normalised number back (designer)
      go(2);
      return;
    }
    const bad = step2Errors(time, consent);
    setErr({ time: bad.includes('time'), consent: bad.includes('consent') });
    if (bad.length) {
      q<HTMLElement>(bad[0] === 'time' ? '[data-time]' : `#${id}-ok`)?.focus();
      return;
    }
    setBusy(true);
    setFail(false);
    try {
      const res = await submitCallback({
        name,
        phone: norm,
        contactTime: time!,
        need: topic,
        planId,
        src,
        consent,
        website: honeypot.current?.value ?? '',
        startedAt: startedAt.current,
        utm: readUtm(),
      });
      setCode(res.trackingCode);
      setWhen(successLine(time!));
      go(3);
    } catch (e2) {
      console.warn('callback submit failed:', e2 instanceof LeadError ? `${e2.code} ${e2.status}` : e2);
      setFail(true); // entered values stay
      requestAnimationFrame(() => failRef.current?.focus());
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (autoFocus && variant === 'sheet') focusLater(`#${id}-n`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const opts = timeOptions(inHours);
  const showWa = wa && !!CALLBACK_WHATSAPP;

  return (
    <div className={`cb cb--${variant}`} ref={root} data-step={step}>
      {variant === 'inline' && !open && (
        <div className="cb-collapsed">
          <p className="cb-h">{title}</p>
          <p className="cb-sub">مطمئن نیستید؟ کارشناس نفیس وام با شما تماس می‌گیرد.</p>
          <button
            type="button"
            className="nf-btn nf-btn--secondary nf-btn--block cb-open"
            aria-expanded={false}
            onClick={() => {
              setOpen(true);
              focusLater(`#${id}-n`);
            }}
          >
            <I name="callback" /> درخواست تماس
          </button>
          <p className="cb-alt">
            یا{' '}
            <a href={SITE.tel}>
              تماس با&nbsp;<span dir="ltr">{SITE.phoneFa}</span>
            </a>{' '}
            ·{' '}
            <a href={MESSENGERS.whatsapp.href} data-todo="whatsapp">
              واتساپ
            </a>
          </p>
        </div>
      )}
      {open && (
        <div className="cb-body">
          {variant !== 'sheet' && (
            <div className="cb-intro">
              <H className="cb-h">{title}</H>
              <p>{lead ?? (variant === 'inline' ? LEAD_INLINE : LEAD_SECTION)}</p>
              {showWa && (
                <p className="cb-alt cb-wa">
                  یا <a href={CALLBACK_WHATSAPP}>در واتساپ بپرسید</a>
                </p>
              )}
            </div>
          )}
          <div className="cb-card">
            {step !== 3 && (
              <div className="cb-head">
                <div className="top">
                  <button type="button" className="back" hidden={step !== 2} aria-label="مرحله قبل" onClick={() => go(1)}>
                    <I name="back" size={20} />
                    قبلی
                  </button>
                  <span className="count">
                    مرحله {fa(step)} از ۲
                  </span>
                </div>
                <div className="nf-progress" role="progressbar" aria-valuemin={1} aria-valuemax={2} aria-valuenow={step} aria-label="پیشرفت درخواست مشاوره" style={{ ['--steps' as string]: 2 }}>
                  <span className={step === 1 ? 'is-current' : 'is-done'} />
                  <span className={step === 2 ? 'is-current' : undefined} />
                </div>
              </div>
            )}
            <div className="alert" role="alert" tabIndex={-1} ref={failRef} hidden={!fail}>
              <I name="alert" />
              <span>
                ثبت نشد. لطفاً دوباره تلاش کنید یا با <a href={SITE.tel}>{SITE.phoneFa}</a> تماس بگیرید
                {' · '}
                <a href={MESSENGERS.whatsapp.href} data-todo="whatsapp">
                  واتساپ
                </a>
                .
              </span>
            </div>
            {step !== 3 && (
              <form noValidate onSubmit={onSubmit}>
                <input ref={honeypot} type="text" name="website" tabIndex={-1} autoComplete="off" className="hp" aria-hidden="true" defaultValue="" />
                <fieldset className="cb-step" data-step="1" hidden={step !== 1}>
                  <legend className="sr">مرحله ۱: نام و شماره</legend>
                  <div className={`nf-field${err.name ? ' field--error' : ''}`}>
                    <label className="nf-label" htmlFor={`${id}-n`}>
                      نام شما
                    </label>
                    <input className="nf-input" id={`${id}-n`} name="name" autoComplete="name" maxLength={80} value={name} aria-invalid={!!err.name} aria-describedby={`${id}-en`} onChange={(e) => setName(e.target.value)} />
                    <span className="nf-error" id={`${id}-en`} hidden={!err.name}>
                      <I name="alert" />
                      لطفاً نام خود را بنویسید.
                    </span>
                  </div>
                  <div className={`nf-field${err.phone ? ' field--error' : ''}`}>
                    <label className="nf-label" htmlFor={`${id}-m`}>
                      شماره موبایل
                    </label>
                    <input
                      className="nf-input nf-input--ltr"
                      id={`${id}-m`}
                      name="mobile"
                      type="tel"
                      inputMode="numeric"
                      autoComplete="tel"
                      dir="ltr"
                      placeholder="۰۹۱۲ ۳۴۵ ۶۷۸۹"
                      maxLength={18}
                      value={phone}
                      aria-invalid={!!err.phone}
                      aria-describedby={`${id}-em`}
                      onChange={(e) => setPhone(e.target.value)}
                    />
                    <span className="nf-error" id={`${id}-em`} hidden={!err.phone}>
                      <I name="alert" />
                      شماره موبایل را درست وارد کنید (مثل ۰۹۱۲۳۴۵۶۷۸۹).
                    </span>
                  </div>
                  <button type="submit" className={`nf-btn ${btn} nf-btn--block`}>
                    ادامه <I name="arrow" />
                  </button>
                </fieldset>
                <fieldset className="cb-step" data-step="2" hidden={step !== 2}>
                  <legend className="sr">مرحله ۲: زمان تماس</legend>
                  <div className="nf-field">
                    <span className="nf-label" id={`${id}-lt`}>
                      چه زمانی تماس بگیریم؟
                    </span>
                    <div className="cb-tiles" role="radiogroup" aria-labelledby={`${id}-lt`} aria-describedby={`${id}-et`} style={{ gridTemplateColumns: `repeat(${opts.length},1fr)` }}>
                      {opts.map((o) => (
                        <button
                          key={o.v}
                          type="button"
                          role="radio"
                          aria-checked={time === o.v}
                          className="nf-option nf-option--tile"
                          data-time={o.v}
                          onClick={() => {
                            setTime(o.v);
                            setErr((p) => ({ ...p, time: false }));
                          }}
                        >
                          <span className="ic">
                            <I name={o.icon} />
                          </span>
                          <b>{o.label}</b>
                          <small>{o.sub}</small>
                        </button>
                      ))}
                    </div>
                    <span className="nf-error" id={`${id}-et`} hidden={!err.time}>
                      <I name="alert" />
                      یک زمان را انتخاب کنید.
                    </span>
                    {!inHours && <p className="cb-closed">الان خارج از ساعت کاری ({WORK_HOURS.fa}) است؛ برای اولین زمان کاری یکی را انتخاب کنید.</p>}
                  </div>
                  <div className="nf-field">
                    <span className="nf-label" id={`${id}-lp`}>
                      موضوع تماس <small className="opt">(اختیاری)</small>
                    </span>
                    <div className="chips cb-topic" role="radiogroup" aria-labelledby={`${id}-lp`}>
                      {TOPIC_OPTS.map((o) => (
                        <button key={o.v} type="button" role="radio" aria-checked={topic === o.v} onClick={() => setTopic(topic === o.v ? null : o.v)}>
                          {o.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <label className="check">
                      <input type="checkbox" id={`${id}-ok`} checked={consent} aria-invalid={!!err.consent} aria-describedby={`${id}-eo`} onChange={(e) => (setConsent(e.target.checked), setErr((p) => ({ ...p, consent: false })))} />
                      <span>
                        با <a href="/privacy">حریم خصوصی</a> موافقم و اجازه می‌دهم کارشناس نفیس وام با من تماس بگیرد.
                      </span>
                    </label>
                    <span className="nf-error" id={`${id}-eo`} hidden={!err.consent}>
                      <I name="alert" />
                      برای ثبت درخواست، این گزینه را تأیید کنید.
                    </span>
                  </div>
                  <button type="submit" className={`nf-btn ${btn} nf-btn--block cb-submit`} disabled={busy} aria-busy={busy}>
                    {busy ? 'در حال ثبت…' : CB_SUBMIT}
                  </button>
                </fieldset>
              </form>
            )}
            {step === 3 && (
              <div className="cb-done" tabIndex={-1}>
                <div className="big">
                  <I name="check" />
                </div>
                <p className="t">{CB_DONE}</p>
                <p className="when">{when}</p>
                {code && (
                  <p className="num">
                    کد پیگیری: <b dir="ltr">{code}</b>
                  </p>
                )}
                <p className="num">
                  شماره: <b dir="ltr">{faMobile(norm)}</b> ·{' '}
                  <button type="button" className="nf-btn nf-btn--text cb-edit" onClick={() => go(1)}>
                    اشتباه است؟ ویرایش
                  </button>
                </p>
              </div>
            )}
            {step !== 3 && (
              <p className="privacy-note cb-note">
                <I name="lock" />
                شماره‌تان فقط برای همین تماس است.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

