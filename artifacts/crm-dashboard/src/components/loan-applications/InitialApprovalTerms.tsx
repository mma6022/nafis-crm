type Snapshot = Record<string, unknown> | null | undefined;

function snapshotArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function amountFromSnapshot(value: unknown): bigint {
  return BigInt(String(value ?? '0').replace(/[۰-۹]/g, d => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).replace(/\D/g, '') || '0');
}

/** Match the effective condition override and plan ceiling used by the API. */
export function getInitialApprovalOptions(planValue: unknown, conditionValue: unknown) {
  const plan = planValue && typeof planValue === 'object' ? planValue as Snapshot : null;
  const condition = conditionValue && typeof conditionValue === 'object' ? conditionValue as Snapshot : null;
  const planMax = amountFromSnapshot(plan?.principal_amount);
  const conditionMax = amountFromSnapshot(condition?.max_principal);
  const maximumAmount = (conditionMax === 0n ? planMax : planMax === 0n ? conditionMax
    : conditionMax < planMax ? conditionMax : planMax).toString();
  const conditionDurations = snapshotArray(condition?.installment_options);
  const planDurations = snapshotArray(plan?.installment_terms).map(term =>
    term && typeof term === 'object' ? (term as Record<string, unknown>).installments : term);
  const allowedDurations = (conditionDurations.length ? conditionDurations : planDurations)
    .map(Number).filter(value => Number.isSafeInteger(value) && value > 0 && value <= 600);
  return { maximumAmount, allowedDurations };
}

function formatAmount(value: string): string {
  return /^\d+$/.test(value) ? BigInt(value).toLocaleString('fa-IR') : '—';
}

function asciiDigits(value: string): string {
  return value.replace(/[۰-۹]/g, digit => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit)))
    .replace(/[٠-٩]/g, digit => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit))).replace(/[^0-9]/g, '');
}

type InitialApprovalTermsProps = {
  requestedAmount: string;
  requestedDuration: number;
  maximumAmount: string;
  allowedDurations: number[];
  approvedAmount: string;
  onAmountChange: (value: string) => void;
  approvedDuration: number;
  onDurationChange: (value: number) => void;
  signedPrimary: boolean;
  keepsInitialContract: boolean;
};

export function InitialApprovalTerms({
  requestedAmount, requestedDuration, maximumAmount, allowedDurations,
  approvedAmount, onAmountChange, approvedDuration, onDurationChange,
  signedPrimary, keepsInitialContract,
}: InitialApprovalTermsProps) {
  const max = BigInt(maximumAmount);
  const sliderAvailable = max > 0n && max <= BigInt(Number.MAX_SAFE_INTEGER);
  const sliderMax = sliderAvailable ? Number(max) : 0;
  const amountStep = sliderMax >= 100_000_000 ? 1_000_000 : sliderMax >= 10_000_000 ? 100_000 : 10_000;
  const sliderMin = Math.min(amountStep, sliderMax);
  const options = allowedDurations.includes(requestedDuration)
    ? allowedDurations : [requestedDuration, ...allowedDurations].filter(value => Number.isSafeInteger(value) && value > 0);
  const changeAmount = (value: string) => {
    const raw = asciiDigits(value);
    onAmountChange(raw && max > 0n && BigInt(raw) > max ? maximumAmount : raw);
  };

  return (
    <div className="funder-approval-terms">
      <div className="funder-requested-terms">
        <span>اصل درخواستی <strong>{formatAmount(requestedAmount)} تومان</strong></span>
        <span>تعداد اقساط درخواستی <strong>{requestedDuration.toLocaleString('fa-IR')} ماهه</strong></span>
      </div>
      <div className="loan-amount-picker">
        <div className="loan-amount-picker-head">
          <div><span>میزان تسهیلات مصوب</span><strong>{formatAmount(approvedAmount)} <small>تومان</small></strong></div>
          <div className="loan-amount-max"><span>سقف این طرح</span><strong>{formatAmount(maximumAmount)} تومان</strong></div>
        </div>
        <label htmlFor="initial-approved-principal" className="sr-only">اصل تسهیلات مصوب (تومان)</label>
        <div className="loan-amount-input-wrap">
          <input id="initial-approved-principal" data-testid="input-initial-approved-amount"
            inputMode="numeric" dir="ltr" value={approvedAmount ? formatAmount(approvedAmount) : ''}
            onChange={event => changeAmount(event.target.value)} />
          <span>تومان</span>
        </div>
        <input className="loan-amount-range" type="range" dir="rtl"
          min={sliderMin} max={sliderMax} step={amountStep}
          value={sliderAvailable ? Math.min(Math.max(Number(approvedAmount) || sliderMin, sliderMin), sliderMax) : 0}
          disabled={!sliderAvailable} onChange={event => onAmountChange(event.target.value)}
          aria-label="انتخاب مبلغ مصوب" data-testid="initial-approved-amount-range" />
        {sliderAvailable
          ? <div className="loan-amount-limits"><span>{sliderMin.toLocaleString('fa-IR')} تومان</span><span>{formatAmount(maximumAmount)} تومان</span></div>
          : <p role="alert">سقف طرح برای نوار مبلغ قابل نمایش نیست؛ مبلغ را وارد کنید و شرایط طرح را بررسی کنید.</p>}
        <div className="loan-duration-picker">
          <div className="loan-duration-title">
            <strong>تعداد اقساط مصوب</strong>
            <span>{approvedDuration ? `${approvedDuration.toLocaleString('fa-IR')} ماهه` : 'یک گزینه را انتخاب کنید'}</span>
          </div>
          <div className="loan-duration-options" data-testid="initial-approved-duration-options">
            {options.map(months => (
              <button key={months} type="button" aria-pressed={months === approvedDuration}
                className={months === approvedDuration ? 'active' : ''}
                onClick={() => onDurationChange(months)}
                data-testid={`initial-approved-duration-${months}`}>
                {months.toLocaleString('fa-IR')} ماهه
              </button>
            ))}
          </div>
        </div>
      </div>
      <p className="funder-approval-warning">اصل تسهیلات و تعداد اقساط را تأیید کنید یا از گزینه‌های طرح تغییر دهید. اگر هر یک از شرایط قرارداد اولیهٔ امضاشده تغییر کند، مشتری باید قرارداد جایگزین را امضا کند.</p>
      {signedPrimary && <p className="funding-guidance" role="status">{keepsInitialContract
        ? 'مبلغ و تعداد اقساط مصوب با قرارداد اولیه برابر است؛ همان قرارداد حفظ می‌شود و امضای مجدد لازم نیست.'
        : 'یکی از شرایط قرارداد اولیه تغییر کرده است؛ پس از ثبت تصمیم باید قرارداد جایگزین صادر و برای امضای مشتری ارسال شود.'}</p>}
    </div>
  );
}