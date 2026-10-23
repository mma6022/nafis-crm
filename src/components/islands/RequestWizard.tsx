/** /request — loan request wizard (skeleton steps; final questions come with the PM spec). */
import { useEffect, useState } from 'react';
import { Wizard, type WizardStep } from './wizard/Wizard';
import { ChoiceGroup, Input, Button } from '../ui/react';
import { normalizeIranMobile, toFaDigits, formatTomanShort } from '../../lib/format';
import { submitLead } from '../../lib/lead';
import type { LoanPlan } from '../../lib/loan-plans';

type Data = {
  loanType: '' | 'goods' | 'score' | 'unsure';
  amount: string;
  months: string;
  planId?: number;
  fullName: string;
  mobile: string;
  city: string;
};
const INITIAL: Data = { loanType: '', amount: '', months: '', fullName: '', mobile: '', city: '' };

const AMOUNT_PRESETS = [100e6, 200e6, 300e6, 400e6, 500e6, 700e6];
/** Presets, plus the deep-linked plan's exact amount if it is not one of them (so it shows as selected). */
const amountOptions = (current: string) =>
  [...new Set([...AMOUNT_PRESETS, ...(+current > 0 ? [+current] : [])])]
    .sort((a, b) => a - b)
    .map((n) => ({ value: String(n), label: formatTomanShort(n) }));

const steps: WizardStep<Data>[] = [
  {
    id: 'type',
    title: 'چه نوع وامی می‌خواهید؟',
    description: 'اگر مطمئن نیستید، «نمی‌دانم» را بزنید؛ کارشناس ما راهنمایی‌تان می‌کند.',
    render: ({ data, set, errors }) => (
      <>
        <ChoiceGroup
          name="loanType"
          label="نوع وام"
          value={data.loanType}
          onChange={(v) => set('loanType', v)}
          options={[
            { value: 'goods', label: 'وام کالایی', hint: 'برای خرید کالا' },
            { value: 'score', label: 'وام امتیازی', hint: 'با امتیاز وام' },
            { value: 'unsure', label: 'نمی‌دانم', hint: 'مشاوره می‌خواهم' },
          ]}
        />
        {errors.loanType && <p className="text-danger text-sm font-semibold">{errors.loanType}</p>}
      </>
    ),
    validate: (d) => (d.loanType ? {} : { loanType: 'یکی از گزینه‌ها را انتخاب کنید.' }),
  },
  {
    id: 'amount',
    title: 'به چه مبلغی نیاز دارید؟',
    render: ({ data, set, errors }) => (
      <>
        <ChoiceGroup
          name="amount"
          label="مبلغ تقریبی"
          value={data.amount}
          onChange={(v) => set('amount', v)}
          options={amountOptions(data.amount)}
        />
        <ChoiceGroup
          name="months"
          label="مدت بازپرداخت دلخواه"
          value={data.months}
          onChange={(v) => set('months', v)}
          options={['12', '18', '24', '36'].map((m) => ({ value: m, label: `${toFaDigits(m)} ماهه` }))}
        />
        {(errors.amount || errors.months) && (
          <p className="text-danger text-sm font-semibold">{errors.amount ?? errors.months}</p>
        )}
      </>
    ),
    validate: (d) =>
      !d.amount ? { amount: 'مبلغ را انتخاب کنید.' } : !d.months ? { months: 'مدت بازپرداخت را انتخاب کنید.' } : {},
  },
  {
    id: 'contact',
    title: 'چطور با شما تماس بگیریم؟',
    description: 'فقط برای هماهنگی همین درخواست استفاده می‌شود.',
    render: ({ data, set, errors }) => (
      <>
        <Input
          label="نام و نام خانوادگی"
          autoComplete="name"
          placeholder="مثلاً سارا احمدی"
          value={data.fullName}
          onChange={(e) => set('fullName', e.target.value)}
          error={errors.fullName}
        />
        <Input
          label="شماره موبایل"
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          dir="ltr"
          className="[&_input]:text-right"
          placeholder="۰۹۱۲ ۱۲۳ ۴۵۶۷"
          value={data.mobile}
          onChange={(e) => set('mobile', e.target.value)}
          error={errors.mobile}
        />
        <Input
          label="شهر (اختیاری)"
          autoComplete="address-level2"
          value={data.city}
          onChange={(e) => set('city', e.target.value)}
        />
      </>
    ),
    validate: (d) => {
      const e: Record<string, string | undefined> = {};
      if (d.fullName.trim().length < 3) e.fullName = 'نام و نام خانوادگی را وارد کنید.';
      if (!normalizeIranMobile(d.mobile)) e.mobile = 'شماره موبایل معتبر نیست (مثلاً ۰۹۱۲۱۲۳۴۵۶۷).';
      return e;
    },
  },
  {
    id: 'review',
    title: 'بازبینی و ثبت',
    description: 'اطلاعات را یک بار نگاه کنید. ثبت درخواست به معنی تعهد نیست.',
    render: ({ data }) => (
      <dl className="divide-line-soft border-line bg-surface divide-y rounded-[var(--radius-lg)] border">
        {[
          ['نوع وام', { goods: 'وام کالایی', score: 'وام امتیازی', unsure: 'نیاز به مشاوره', '': '—' }[data.loanType]],
          ['مبلغ', data.amount ? formatTomanShort(+data.amount) : '—'],
          ['مدت', data.months ? `${toFaDigits(data.months)} ماه` : '—'],
          ['نام', data.fullName],
          ['موبایل', toFaDigits(normalizeIranMobile(data.mobile) ?? data.mobile)],
        ].map(([k, v]) => (
          <div key={k} className="flex justify-between gap-4 px-4 py-3">
            <dt className="text-ink-muted">{k}</dt>
            <dd className="text-ink font-semibold">{v}</dd>
          </div>
        ))}
      </dl>
    ),
  },
];

export default function RequestWizard({ plans = [] }: { plans?: LoanPlan[] }) {
  const [initial, setInitial] = useState(INITIAL);
  const [plan, setPlan] = useState<LoanPlan | null>(null);
  const [preview, setPreview] = useState(false);
  // Deep link from a plan card: /request?plan=10
  useEffect(() => {
    const id = Number(new URLSearchParams(location.search).get('plan'));
    const plan = plans.find((p) => p.id === id);
    if (plan) {
      setPlan(plan);
      setInitial({
        ...INITIAL,
        planId: plan.id,
        loanType: plan.loanType === 'score' ? 'score' : 'goods',
        amount: String(plan.principalAmount),
      });
    }
  }, [plans]);

  return (
    <>
      {plan && (
        <p className="border-brand-200 bg-brand-50 text-brand-700 mb-4 rounded-[var(--radius)] border px-4 py-3 font-semibold">
          طرح انتخابی شما: {plan.name} — {formatTomanShort(plan.principalAmount)}
        </p>
      )}
      <Wizard<Data>
        key={initial.planId ?? 'none'}
        storageKey="nafis.request.v1"
        steps={steps}
        initial={initial}
        pinned={plan ? { planId: initial.planId, loanType: initial.loanType, amount: initial.amount } : undefined}
        onSubmit={async (d) => {
          const r = await submitLead({
            ...d,
            mobile: normalizeIranMobile(d.mobile) ?? d.mobile,
            source: 'nafisvam.com/request',
          });
          setPreview(r.preview);
        }}
        done={(d, restart) => (
          <div className="py-6 text-center">
            <div className="bg-success-50 text-success mx-auto mb-4 flex size-16 items-center justify-center rounded-full">
              <svg
                viewBox="0 0 24 24"
                className="size-8"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                aria-hidden="true"
              >
                <path d="M5 12.5l4.5 4.5L19 7.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
            <h2 className="text-2xl font-extrabold">{d.fullName.split(' ')[0]} عزیز، درخواست شما ثبت شد</h2>
            <p className="text-ink-muted mt-2">کارشناسان نفیس وام به‌زودی با شما تماس می‌گیرند.</p>
            {preview && (
              <p className="bg-gold-50 text-gold-700 mx-auto mt-4 max-w-md rounded-[var(--radius)] px-4 py-2 text-sm font-semibold">
                نسخه پیش‌نمایش: ارسال هنوز به CRM وصل نشده و این درخواست جایی ثبت نشد.
              </p>
            )}
            <Button variant="secondary" className="mt-6" onClick={restart}>
              ثبت درخواست دیگر
            </Button>
          </div>
        )}
      />
    </>
  );
}
