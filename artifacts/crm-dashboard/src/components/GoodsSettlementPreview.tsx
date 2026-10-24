import { CustomerName, customerNameText } from '@/components/customer/CustomerName';
import { useState } from 'react';
import { Banknote, AlertTriangle } from 'lucide-react';
import { toBig, toman, type Purchase } from '@/lib/goods-api';
import { Wizard } from '@/components/goods/GpKit';

const fa = (s: string) => s.replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[Number(d)]).replace('.', '٫');
/** Persian/Arabic digits and decimal separators → ASCII "12.5"; keeps at most one dot. */
export function normalizePercentInput(raw: string): string {
  const ascii = raw.replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d))).replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).replace(/[٫/,]/g, '.');
  const clean = ascii.replace(/[^\d.]/g, '');
  const [i, ...rest] = clean.split('.');
  return rest.length ? `${i}.${rest.join('')}` : i;
}
/** "12.5" → 1250 hundredths of a percent; null when malformed or more than 2 decimals. */
export function percentToBps(v: string): number | null {
  if (!/^\d{1,3}(\.\d{0,2})?$/.test(v)) return null;
  const [i, d = ''] = v.split('.');
  return Number(i) * 100 + Number((d + '00').slice(0, 2));
}
/** Final payout = round(principal × pct / 100), computed exactly on bigint hundredths of a percent. */
export const payoutFor = (principal: bigint, bps: number) => (principal * BigInt(bps) + 5000n) / 10000n;
const bpsText = (bps: number) => fa((bps / 100).toFixed(2).replace(/\.?0+$/, ''));

export default function GoodsSettlementPreview({ purchase: p, canSettle, busy, onSettle }: {
  purchase: Purchase; canSettle: boolean; busy: boolean; onSettle: (discount: string) => void;
}) {
  const pending = p.stage === 'settlement_pending';
  const base = toBig(p.basePayoutAmountToman ?? p.payoutAmountToman);
  const principal = toBig(p.principalAmountToman);
  const final = pending ? base : toBig(p.payoutAmountToman);
  const pctOf = (v: bigint) => (principal > 0n ? Number((v * 10000n + principal / 2n) / principal) : null);
  const [open, setOpen] = useState(false);
  return <div className="panel gp-stage-panel" data-testid="settlement-preview">
    <div className="panel-head"><div><h3><Banknote size={16} /> تسویه با شرکت</h3>
      <p>درصد واریزی از اصل تسهیلات تأییدشده حساب می‌شود؛ تفاوت با پیش‌فرض طرح به‌عنوان تخفیف کارمزد ثبت می‌شود.</p></div></div>
    <div className="gp-figures">
      <Amount label="اعتبار مصرفی" value={p.creditAmountToman} />
      <Amount label="اصل تسهیلات" value={p.principalAmountToman} />
      <Amount label="تخفیف توسعه" value={p.developmentDiscountToman} />
      <Amount label="خالص اعتبار شرکت" value={p.companyCreditToman} />
      <Amount label="واریزی پیش‌فرض مشتری" value={base.toString()} />
    </div>
    <div className="gp-figures" aria-live="polite" style={{ marginTop: 14 }}>
      {!pending ? <div className="gp-fig"><span>تخفیف کارمزد</span><strong dir="auto" data-testid="settlement-fee-discount">{toBig(p.feeDiscountToman) > 0n ? '+' : ''}{toman(p.feeDiscountToman ?? '0')}</strong></div> : null}
      <div className="gp-fig teal"><span>{pending ? 'واریزی پیش‌فرض' : 'مبلغ نهایی واریزی به مشتری'}{pctOf(final) !== null ? ` · ${bpsText(pctOf(final)!)}٪ اصل` : ''}</span><strong data-testid="settlement-final-payout">{toman(final.toString())}</strong></div>
    </div>
    {pending ? <button className="btn btn-primary gp-btn-primary" disabled={!canSettle || busy} data-testid="button-settle" onClick={() => setOpen(true)}>
      {canSettle ? 'تعیین درصد و ثبت تسویه' : 'نیازمند دسترسی مالی'}</button> : null}
    {open ? <SettleWizard p={p} principal={principal} base={base} defaultBps={pctOf(base)} busy={busy} onClose={() => setOpen(false)} onSettle={(d) => { onSettle(d); setOpen(false); }} /> : null}
  </div>;
}

function SettleWizard({ p, principal, base, defaultBps, busy, onClose, onSettle }: { p: Purchase; principal: bigint; base: bigint; defaultBps: number | null; busy: boolean; onClose: () => void; onSettle: (discount: string) => void }) {
  const initial = defaultBps === null ? '' : (defaultBps / 100).toFixed(2).replace(/\.?0+$/, '');
  const [value, setValue] = useState(initial);
  const [step, setStep] = useState(0);
  const bps = percentToBps(value);
  const untouched = value === initial;
  const inRange = bps !== null && bps > 0 && bps <= 10000;
  const final = untouched ? base : inRange ? payoutFor(principal, bps!) : null;
  const discount = final === null ? null : final - base;
  const gap = inRange && defaultBps !== null ? (bps! - defaultBps) / 100 : 0;
  const noPrincipal = principal <= 0n;
  return <Wizard title="تسویه با شرکت" testId="settle-wizard" steps={['درصد واریزی', 'بازبینی و ثبت']} step={step} onClose={onClose} onBack={step ? () => setStep(0) : undefined}
    summary={<><span>{customerNameText(p.customerName, p.customerId)}</span><b>{toman(final?.toString() ?? '0')}</b></>}
    next={step === 0 ? { label: 'بعدی', disabled: noPrincipal || final === null || final <= 0n, onClick: () => setStep(1), testId: 'button-settle-next' }
      : { label: busy ? 'در حال ثبت تسویه…' : 'ثبت تسویه', tone: 'green', disabled: busy || discount === null, onClick: () => discount !== null && onSettle(discount.toString()), testId: 'button-settle-confirm' }}>
    {step === 0 ? <>
      {noPrincipal ? <div className="gp-alert" role="alert">اصل تسهیلات تأییدشده برای این خرید ثبت نشده؛ تسویه ممکن نیست.</div> : null}
      <label className="gp-label" htmlFor={`settle-pct-${p.id}`}>درصد واریزی از اصل تسهیلات ({toman(principal.toString())})</label>
      <div className="gp-pct-row">
        <input id={`settle-pct-${p.id}`} dir="ltr" inputMode="decimal" value={value} disabled={noPrincipal} onChange={(e) => setValue(normalizePercentInput(e.target.value).slice(0, 6))} data-testid="input-payout-percent" />
        <span className="gp-pct-sign">٪</span>
        {defaultBps !== null ? <button type="button" className="gp-chip light" onClick={() => setValue(initial)} data-testid="chip-plan-default">{bpsText(defaultBps)}٪ · پیش‌فرض طرح</button> : null}
      </div>
      {!noPrincipal && !inRange && !untouched ? <p className="gp-alert" role="alert" data-testid="error-payout-percent">درصد باید بین ۰ و ۱۰۰ باشد (حداکثر دو رقم اعشار، بیشتر از صفر).</p> : null}
      {inRange && Math.abs(gap) > 10 ? <p className="gp-alert warn" role="status" data-testid="warn-payout-percent"><AlertTriangle size={14} /> {fa(Math.abs(gap).toFixed(2).replace(/\.?0+$/, ''))} واحد {gap < 0 ? 'کمتر' : 'بیشتر'} از پیش‌فرض طرح است. اگر درست است، ادامه بده.</p> : null}
      <div className="gp-kv" aria-live="polite">
        <span>واریزی پیش‌فرض طرح</span><b>{toman(base.toString())}</b>
        <span>واریزی با این درصد</span><b data-testid="settle-live-payout">{final === null ? '—' : toman(final.toString())}</b>
        <span>تخفیف کارمزد</span><b dir="auto">{discount === null ? '—' : `${discount > 0n ? '+' : ''}${toman(discount.toString())}`}</b>
      </div>
    </> : <>
      <div className="gp-kv gp-review">
        <span>مشتری</span><b><CustomerName id={p.customerId} name={p.customerName} /></b>
        <span>طرح</span><b>{p.planName}</b>
        <span>اصل تسهیلات</span><b>{toman(principal.toString())}</b>
        <span>درصد واریزی</span><b>{untouched && defaultBps !== null ? bpsText(defaultBps) : bpsText(bps ?? 0)}٪</b>
        <span>تخفیف کارمزد</span><b dir="auto" data-testid="settlement-fee-discount">{discount === null ? '—' : `${discount > 0n ? '+' : ''}${toman(discount.toString())}`}</b>
        <span>مبلغ نهایی واریزی</span><b className="gp-total" data-testid="settlement-final-payout">{toman(final?.toString() ?? '0')}</b>
      </div>
      <p className="gp-note">پس از ثبت تسویه، این مبلغ قابل تغییر نیست و دستور پرداخت با همین مبلغ ساخته می‌شود.</p>
    </>}
  </Wizard>;
}

function Amount({ label, value }: { label: string; value?: string | null }) {
  return <div className="gp-fig"><span>{label}</span><strong>{toman(value)}</strong></div>;
}
