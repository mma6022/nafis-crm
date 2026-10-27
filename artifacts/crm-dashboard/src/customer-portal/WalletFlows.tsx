// «شارژ کیف پول» wizard and «هزینه تشکیل پرونده» page (HANDOFF part 2 §3). Server rules unchanged:
// top-up goes through portalApi.topUpAndPay, the fee through portalApi.filingFee with the same idempotency key as «ثبت درخواست».
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useLocation, useSearch } from 'wouter';
import { AlertCircle, ArrowLeft, ArrowRight, Ban, Check, ChevronLeft, CreditCard, Info, Lock, RefreshCw, RotateCcw, ShieldCheck } from 'lucide-react';
import { portalApi, PortalApiError } from './api';
import { useLoanSelection } from './use-loan-selection';
import { readPaymentDraft } from './payment-return';
import { ErrorBox, Icon, Sep, SkeletonCards, fa } from './PortalUi';
import { Crumb, ExpertLink, Toman, moneyWords } from './Portal2Ui';

const digits = (v: string) => v.replace(/[۰-۹]/g, c => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(c))).replace(/[٠-٩]/g, c => String('٠١٢٣٤٥٦٧٨٩'.indexOf(c))).replace(/[,\s٬،]/g, '');
const msg = (e: unknown) => e instanceof Error ? e.message : 'درخواست انجام نشد. دوباره تلاش کنید.';
const code = (e: unknown) => e instanceof PortalApiError ? e.code ?? '' : '';
const big = (v: unknown) => { try { return /^\d+$/.test(String(v ?? '')) ? BigInt(String(v)) : null; } catch { return null; } };
const n = (v: bigint | null) => v == null ? 0 : Number(v);
const QUICK = [500_000, 1_000_000, 2_000_000, 5_000_000];

function goToGateway(paymentUrl: string | undefined) {
  const u = new URL(paymentUrl ?? '');
  if (u.protocol !== 'https:') throw new Error('bad');
  window.location.assign(u.href);
}

/** Amount of an unfinished checkout this tab already started (see portalApi.topUpAndPay). */
function cachedCheckoutAmount(customerId: number | null | undefined): string | null {
  if (!customerId) return null;
  try {
    const prefix = `customer-wallet-checkout:${customerId}:`;
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i);
      if (k?.startsWith(prefix) && /^\d+$/.test(k.slice(prefix.length))) return k.slice(prefix.length);
    }
  } catch { /* no storage */ }
  return null;
}

function WizardHead({ step, total, names, label, back }: { step: number; total: number; names: string[]; label: string; back?: ReactNode }) {
  return <>
    <div className="nfp-wz-meta">{back ?? <span />}<span>مرحله <b>{fa(step)}</b> از {fa(total)}<Sep />{names[step - 1]}</span></div>
    <div className="nf-progress" style={{ ['--steps' as string]: total }} role="progressbar" aria-valuemin={1} aria-valuemax={total} aria-valuenow={step} aria-label={label}>
      {names.map((_, i) => <span key={i} className={i < step - 1 ? 'is-done' : i === step - 1 ? 'is-current' : ''} />)}</div>
  </>;
}

function Title({ children, sub, focusKey }: { children: ReactNode; sub?: ReactNode; focusKey?: unknown }) {
  const ref = useRef<HTMLHeadingElement>(null);
  const first = useRef(true);
  useEffect(() => { if (first.current) { first.current = false; return; } ref.current?.focus(); }, [focusKey]);
  return <div className="nfp-wz-ttl"><h1 ref={ref} tabIndex={-1}>{children}</h1>{sub && <p>{sub}</p>}</div>;
}

export function WalletTopUpWizard() {
  const params = new URLSearchParams(useSearch());
  const fromFee = params.get('from') === 'fee' && /^\d+$/.test(params.get('planId') ?? '');
  const shortParam = big(params.get('amount'));
  const me = useQuery({ queryKey: ['customer', 'me'], queryFn: portalApi.me, retry: false });
  const wallet = useQuery({ queryKey: ['customer', 'wallet'], queryFn: portalApi.wallet });
  const [step, setStep] = useState(1);
  const [raw, setRaw] = useState(() => shortParam && shortParam > 0n ? String(shortParam) : '');
  const [touched, setTouched] = useState(false);
  const [problem, setProblem] = useState<'' | 'active' | 'gate' | 'link' | string>('');
  const pay = useMutation({ mutationFn: (a: string) => portalApi.topUpAndPay(a), retry: false });
  const amount = digits(raw);
  const amountBig = big(amount);
  const err = !amount ? 'مبلغ را وارد کنید.' : amountBig == null || amountBig <= 0n ? 'مبلغ شارژ را درست وارد کنید.' : '';
  const cash = big(wallet.data?.cashBalanceToman);
  const shown = amountBig != null ? Number(amountBig).toLocaleString('fa-IR') : raw;
  const cached = cachedCheckoutAmount(me.data?.id);

  const start = (a: string) => {
    setProblem('');
    pay.mutate(a, {
      onSuccess: r => { try { goToGateway(r?.paymentUrl); } catch { setProblem('link'); } },
      onError: e => {
        const c = code(e);
        if (c === 'active_top_up_exists' || (e instanceof PortalApiError && e.status === 409)) setProblem('active');
        else if (c === 'payment_configuration_unavailable' || (e instanceof PortalApiError && e.status === 503)) setProblem('gate');
        else setProblem(msg(e));
      },
    });
  };
  const next = (e: FormEvent) => { e.preventDefault(); setTouched(true); if (!err) { setStep(2); setProblem(''); } };
  const back = step === 2 ? <button type="button" className="nfp-wz-back" onClick={() => { setStep(1); setProblem(''); }} data-testid="button-topup-back"><Icon icon={ArrowRight} small />قبلی</button> : undefined;

  return <div className="nfp-stack" data-testid="page-wallet-topup">
    <Crumb items={[['کیف پول', '/customer/wallet'], ['شارژ']]} />
    <div className="nfp-wz nfp-mw nfp-stack">
      <WizardHead step={step} total={2} names={['مبلغ', 'تأیید و پرداخت']} label="پیشرفت شارژ کیف پول" back={back} />
      {step === 1 ? <form className="nfp-card nfp-stack" onSubmit={next} noValidate>
        <Title sub={wallet.isLoading ? 'در حال دریافت موجودی…' : cash != null ? <>موجودی فعلی: <Toman value={n(cash)} /></> : undefined}>چه مبلغی شارژ شود؟</Title>
        {fromFee && shortParam != null && shortParam > 0n && <div className="nfp-alert nfp-info" role="status"><Icon icon={Info} small /><span>برای پرداخت هزینه تشکیل پرونده <b><Toman value={n(shortParam)} /></b> کم دارید.</span></div>}
        <div className="nfp-amt">
          <div className="nf-field"><label className="nf-label" htmlFor="topup-amount">مبلغ (تومان)</label>
            <input id="topup-amount" className="nf-input" inputMode="numeric" autoComplete="off" dir="ltr" placeholder="مثلاً ۱٬۰۰۰٬۰۰۰" value={shown}
              aria-invalid={touched && !!err} aria-describedby="topup-words topup-err" onChange={e => setRaw(digits(e.target.value).replace(/\D/g, ''))} data-testid="input-topup-amount" />
            <div className="nfp-words" id="topup-words" aria-live="polite">{amountBig && amountBig > 0n ? moneyWords(n(amountBig)) : ''}</div>
            {touched && err && <p className="nf-error" id="topup-err" role="alert">{err}</p>}</div>
          <div className="nfp-quick" role="group" aria-label="مبلغ‌های پیشنهادی">{QUICK.map(q => <button key={q} type="button" className="nfp-ap-chip" aria-pressed={amount === String(q)} onClick={() => { setRaw(String(q)); setTouched(false); }} data-testid={`chip-topup-${q}`}>{moneyWords(q, false)}</button>)}</div>
        </div>
        <div className="nfp-wz-foot"><button className="nf-btn nf-btn--primary nf-btn--block" data-testid="button-topup-next">ادامه</button>
          <div className="nfp-next-hint"><Icon icon={ChevronLeft} /><span>مرحله بعد: <b>تأیید و رفتن به درگاه پرداخت</b></span></div></div>
      </form> : <section className="nfp-card nfp-stack">
        <Title focusKey={step}>تأیید و پرداخت</Title>
          <div className="nfp-sum"><div className="nfp-tot"><span>مبلغ شارژ</span><b><Toman value={n(amountBig)} /></b></div>
            {cash != null && <div><span>موجودی بعد از شارژ</span><b><Toman value={n(cash) + n(amountBig)} /></b></div>}</div>
          <div className="nfp-gate"><span className="nfp-ic" aria-hidden="true"><Icon icon={CreditCard} /></span><span><b>درگاه پرداخت زرین‌پال</b><small>با همه‌ی کارت‌های بانکی عضو شتاب</small></span></div>
        {problem === 'active' && <div className="nfp-alert nfp-warn" role="alert"><Icon icon={AlertCircle} small /><span>یک شارژ نیمه‌تمام دارید. همان را ادامه دهید یا چند دقیقه بعد دوباره تلاش کنید.</span></div>}
        {problem === 'gate' && <div className="nfp-alert nfp-warn" role="alert"><Icon icon={AlertCircle} small /><span>درگاه پرداخت الان در دسترس نیست. چند دقیقه بعد دوباره تلاش کنید.</span></div>}
        {problem === 'link' && <div className="nfp-alert" role="alert"><Icon icon={AlertCircle} small /><span>لینک پرداخت امن دریافت نشد؛ مبلغی کم نشد. دوباره تلاش کنید.</span></div>}
        {problem && !['active', 'gate', 'link'].includes(problem) && <div className="nfp-alert" role="alert"><Icon icon={AlertCircle} small /><span>{problem}</span></div>}
        <div className="nfp-wz-foot">
          {problem === 'active' && cached
            ? <button type="button" className="nf-btn nf-btn--primary nf-btn--block" disabled={pay.isPending} onClick={() => start(cached)} data-testid="button-topup-resume">{pay.isPending ? <><Icon icon={RefreshCw} small />در حال اتصال به درگاه…</> : 'ادامه‌ی پرداخت نیمه‌تمام'}</button>
            : <button type="button" className="nf-btn nf-btn--primary nf-btn--block" disabled={pay.isPending} onClick={() => start(amount)} data-testid="button-topup-pay">{pay.isPending ? <><Icon icon={RefreshCw} small />در حال اتصال به درگاه…</> : <><Icon icon={Lock} small />پرداخت {Number(amountBig ?? 0n).toLocaleString('fa-IR')} تومان</>}</button>}
          <p className="nfp-trust"><Icon icon={ShieldCheck} small />بعد از پرداخت، خودکار به همین صفحه برمی‌گردید.</p></div>
      </section>}
    </div>
  </div>;
}

/** /customer/wallet/fee?planId=… — pays the filing fee from cash, for the amount + installments saved by «ثبت درخواست». */
export function WalletFeePage() {
  const params = new URLSearchParams(useSearch());
  const planId = Number(params.get('planId'));
  const valid = Number.isSafeInteger(planId) && planId > 0;
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();
  const me = useQuery({ queryKey: ['customer', 'me'], queryFn: portalApi.me, retry: false });
  const options = useQuery({ queryKey: ['customer', 'options'], queryFn: portalApi.options, enabled: valid });
  const intake = useQuery({ queryKey: ['customer', 'intake', planId], queryFn: () => portalApi.intakeStatus(planId), enabled: valid });
  const wallet = useQuery({ queryKey: ['customer', 'wallet'], queryFn: portalApi.wallet });
  const draft = readPaymentDraft(me.data?.id ?? 0, planId);
  const selection = useLoanSelection(planId, draft.amount, draft.duration, valid && !!me.data && !!options.data?.some(p => p.planId === planId));
  const charge = useMutation({ mutationFn: (v: { key: string; body: { planId: number; conditionId: number; requestedAmount: string; durationMonths: number } }) => portalApi.filingFee(v.body, v.key), retry: false });
  const [error, setError] = useState<{ code: string; text: string } | null>(null);
  const [paid, setPaid] = useState<{ remaining: bigint | null } | null>(null);
  const crumb = <Crumb items={[['کیف پول', '/customer/wallet'], ['هزینه تشکیل پرونده']]} />;
  const frame = (body: ReactNode) => <div className="nfp-stack" data-testid="page-wallet-fee">{crumb}<div className="nfp-mw nfp-stack">{body}</div></div>;
  const toApply = `/customer/apply?planId=${planId}`;

  if (!valid) return frame(<div className="nfp-card"><div className="nfp-empty"><span className="nfp-big"><Icon icon={Ban} /></span><h2>درخواستی برای پرداخت پیدا نشد</h2><p>از صفحه‌ی طرح‌ها یک طرح را انتخاب کنید و ثبت درخواست را شروع کنید.</p><Link className="nf-btn nf-btn--primary" href="/customer/plans">دیدن طرح‌ها</Link></div></div>);
  if (me.isLoading || options.isLoading || intake.isLoading || wallet.isLoading || selection.pending) return frame(<><Title>هزینه تشکیل پرونده</Title><SkeletonCards n={1} /></>);
  if (options.isError) return frame(<ErrorBox title="طرح‌ها بارگیری نشد" text={msg(options.error)} retry={() => void options.refetch()} />);
  if (intake.isError || !intake.data) return frame(<ErrorBox title="وضعیت درخواست بارگیری نشد" text={msg(intake.error)} retry={() => void intake.refetch()} />);
  if (wallet.isError) return frame(<ErrorBox title="موجودی کیف پول بارگیری نشد" text={msg(wallet.error)} retry={() => void wallet.refetch()} />);

  const status = intake.data;
  const plan = options.data?.find(p => p.planId === planId);
  const planName = plan ? <>{plan.name}{plan.bankName && <><Sep />{plan.bankName}</>}</> : undefined;
  const feeBig = big(status.filingFeeToman);
  const cash = big(wallet.data?.cashBalanceToman);

  if (paid || status.feeChargeId != null) {
    const fresh = !!paid;
    return frame(<section className="nfp-card"><div className="nfp-res" role="status" data-testid={fresh ? 'panel-fee-paid' : 'panel-fee-already-paid'}>
      <span className="nfp-big"><Icon icon={Check} /></span>
      <h1>{fresh ? 'هزینه تشکیل پرونده پرداخت شد' : 'این هزینه قبلاً پرداخت شده'}</h1>
      {feeBig != null && <div className="nfp-amount"><Toman value={n(feeBig)} /></div>}
      {!fresh && <p>دوباره از کیف پول کم نشد.</p>}
      <div className="nfp-sum">{plan && <div><span>طرح</span><b>{plan.name}</b></div>}
        {(fresh ? paid?.remaining : cash) != null && <div><span>موجودی نقدی باقی‌مانده</span><b><Toman value={n((fresh ? paid?.remaining : cash) ?? null)} /></b></div>}</div>
      <div className="nfp-btn-row"><Link className="nf-btn nf-btn--primary nf-btn--block" href={toApply} data-testid="link-fee-continue">ادامه‌ی ثبت درخواست<Icon icon={ArrowLeft} small /></Link></div>
    </div></section>);
  }

  const chosen = selection.conditionId;
  const cond = plan?.conditions?.find(c => c.id === chosen);
  const durations = cond?.allowedDurations ?? selection.durations ?? plan?.allowedDurations ?? [];
  const requested = digits(draft.amount);
  const amountOk = /^\d+$/.test(requested) && BigInt(requested) > 0n && !!chosen; // range: server (selection + submit)
  const hasDraft = !!draft.amount.trim() && !!draft.duration.trim();
  const selectionOk = !!plan && !!chosen && amountOk && durations.includes(Number(draft.duration));
  const c = error?.code ?? '';
  const stale = !status.creditValid || c === 'credit_check_stale';
  const noMatch = !stale && (!plan || !status.planEligible || (hasDraft && !selectionOk) || c === 'loan_plan_condition_not_matched' || c === 'loan_plan_not_found');
  const noConfig = !stale && !noMatch && (feeBig == null || c === 'invalid_filing_fee');
  const short = feeBig != null && cash != null && cash < feeBig ? feeBig - cash : null;
  const feeKey = `customer-fee:${me.data?.id}:${planId}`;

  const payFee = async () => {
    if (!selectionOk || !chosen || feeBig == null || charge.isPending) return;
    setError(null);
    let key = ''; try { key = sessionStorage.getItem(feeKey) || ''; } catch { /* guarded server-side */ }
    if (!key) { key = crypto.randomUUID(); try { sessionStorage.setItem(feeKey, key); } catch { /* guarded server-side */ } }
    try {
      const r = await charge.mutateAsync({ key, body: { planId, conditionId: chosen, requestedAmount: requested, durationMonths: Number(draft.duration) } });
      if (typeof r.chargeId !== 'number') throw new Error('رسید پرداخت از سرور دریافت نشد. وضعیت را به‌روزرسانی کنید.');
      setPaid({ remaining: cash != null ? cash - feeBig : null });
    } catch (e) { setError({ code: code(e), text: msg(e) }); }
    finally { void Promise.all(['wallet', 'wallet-transactions', 'intake'].map(k => queryClient.invalidateQueries({ queryKey: ['customer', k] }))); }
  };

  const alert = stale ? <div className="nfp-alert nfp-warn" role="alert"><Icon icon={AlertCircle} small /><span>نتیجه‌ی اعتبارسنجی شما قدیمی شده است. اول اعتبارسنجی را دوباره انجام دهید.</span></div>
    : noMatch ? <div className="nfp-alert nfp-warn" role="alert"><Icon icon={AlertCircle} small /><span>شرایط این طرح با اطلاعات شما جور نیست. مبلغ یا تعداد اقساط را تغییر دهید یا <ExpertLink>با کارشناس صحبت کنید</ExpertLink>.</span></div>
    : noConfig ? <div className="nfp-alert nfp-info" role="alert"><Icon icon={Info} small /><span>مبلغ این هزینه هنوز مشخص نشده است. <ExpertLink>با کارشناس صحبت کنید</ExpertLink>.</span></div>
    : !hasDraft ? <div className="nfp-alert nfp-info" role="status"><Icon icon={Info} small /><span>اول مبلغ واریزی و تعداد اقساط را در ثبت درخواست انتخاب کنید.</span></div>
    : c === 'customer_profile_incomplete' || c === 'customer_identity_not_verified' ? <div className="nfp-alert" role="alert"><Icon icon={AlertCircle} small /><span>{error?.text} <Link href="/customer/profile">رفتن به پروفایل</Link></span></div>
    : error && c !== 'insufficient_cash_balance' ? <div className="nfp-alert" role="alert"><Icon icon={AlertCircle} small /><span>پرداخت انجام نشد و مبلغی از کیف پول کم نشد. دوباره تلاش کنید.</span></div>
    : null;
  const topUpHref = short != null ? `/customer/wallet/top-up?from=fee&planId=${planId}&amount=${short}` : '';
  const action = stale ? <Link className="nf-btn nf-btn--primary nf-btn--block" href={toApply} data-testid="link-fee-recheck"><Icon icon={RotateCcw} small />اعتبارسنجی دوباره</Link>
    : noMatch ? <Link className="nf-btn nf-btn--primary nf-btn--block" href="/customer/advice/finder" data-testid="link-fee-finder">کمک در انتخاب طرح</Link>
    : noConfig ? null
    : !hasDraft ? <Link className="nf-btn nf-btn--primary nf-btn--block" href={toApply} data-testid="link-fee-choose">انتخاب مبلغ و اقساط</Link>
    : short != null ? <button type="button" className="nf-btn nf-btn--primary nf-btn--block" onClick={() => navigate(topUpHref)} data-testid="button-fee-topup"><Icon icon={CreditCard} small />شارژ {Number(short).toLocaleString('fa-IR')} تومان و پرداخت</button>
    : <button type="button" className="nf-btn nf-btn--primary nf-btn--block" disabled={charge.isPending} onClick={() => void payFee()} data-testid="button-fee-pay">{charge.isPending ? <><Icon icon={RefreshCw} small />در حال پرداخت…</> : <><Icon icon={Lock} small />پرداخت از کیف پول</>}</button>;
  return frame(<>
    <section className="nfp-card nfp-stack">
      <Title sub={planName}>هزینه تشکیل پرونده</Title>
      <div className="nfp-sum"><div className="nfp-tot"><span>مبلغ</span><b>{feeBig != null ? <Toman value={n(feeBig)} /> : 'بعداً اعلام می‌شود'}</b></div>
        <div><span>موجودی نقدی کیف پول</span><b>{cash != null ? <Toman value={n(cash)} /> : '—'}</b></div>
        {short != null && !stale && !noMatch && <div className="nfp-short"><span>کمبود موجودی</span><b><Toman value={n(short)} /></b></div>}</div>
      {alert}
      <div className="nfp-wz-foot">{action}</div>
    </section>
    <p className="nfp-trust"><Icon icon={ShieldCheck} small />مبلغ از موجودی نقدی کیف پول کم می‌شود.</p>
  </>);
}
