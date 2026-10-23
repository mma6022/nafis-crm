import { useState } from 'react';
import { Banknote } from 'lucide-react';
import { digitsOnly, toBig, toman, type Purchase } from '@/lib/goods-api';

export default function GoodsSettlementPreview({ purchase: p, canSettle, busy, onSettle }: {
  purchase: Purchase; canSettle: boolean; busy: boolean; onSettle: (discount: string) => void;
}) {
  const [sign, setSign] = useState<1 | -1>(1);
  const [value, setValue] = useState('0');
  const pending = p.stage === 'settlement_pending';
  const base = toBig(p.basePayoutAmountToman ?? p.payoutAmountToman);
  const discount = pending ? BigInt(value || '0') * BigInt(sign) : toBig(p.feeDiscountToman);
  const final = pending ? base + discount : toBig(p.payoutAmountToman);
  const valid = final > 0n && final.toString().length <= 30;
  const signedDiscount = `${discount > 0n ? '+' : ''}${toman(discount.toString())}`;
  return <div className="panel gp-stage-panel" data-testid="settlement-preview">
    <div className="panel-head"><div><h3><Banknote size={16} /> تسویه با شرکت</h3>
      <p>پیش‌نمایش مبالغ پیش از ثبت تسویه؛ تخفیف کارمزد فقط مبلغ واریزی مشتری را تغییر می‌دهد.</p></div></div>
    <div className="gp-figures">
      <Amount label="اعتبار مصرفی" value={p.creditAmountToman} />
      <Amount label="اصل تسهیلات" value={p.principalAmountToman} />
      <Amount label="تخفیف توسعه" value={p.developmentDiscountToman} />
      <Amount label="خالص اعتبار شرکت" value={p.companyCreditToman} />
      <Amount label="واریزی پیش‌فرض مشتری" value={base.toString()} />
    </div>
    {pending ? <fieldset disabled={!canSettle || busy} style={{ border: 0, padding: 0, margin: '18px 0' }}>
      <legend style={{ fontWeight: 700, marginBottom: 10 }}>تخفیف کارمزد (تومان)</legend>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
        <button type="button" className={`btn ${sign === 1 ? 'btn-primary' : ''}`} aria-pressed={sign === 1}
          data-testid="button-fee-discount-plus" onClick={() => setSign(1)}>+ افزایش واریزی مشتری</button>
        <button type="button" className={`btn ${sign === -1 ? 'btn-primary' : ''}`} aria-pressed={sign === -1}
          data-testid="button-fee-discount-minus" onClick={() => setSign(-1)}>− کاهش واریزی مشتری</button>
      </div>
      <label htmlFor={`fee-discount-${p.id}`}>مبلغ تخفیف کارمزد</label>
      <input id={`fee-discount-${p.id}`} inputMode="numeric" value={value}
        style={{ display: 'block', maxWidth: 320, marginTop: 8 }} data-testid="input-fee-discount"
        onChange={e => setValue(digitsOnly(e.target.value).slice(0, 30))} />
      <p className="secondary-cell" style={{ marginTop: 8 }}>پیش‌فرض صفر است. مثبت به واریزی اضافه می‌شود و منفی از آن کم می‌شود.</p>
    </fieldset> : null}
    <div className="gp-figures" aria-live="polite" style={{ marginTop: 14 }}>
      <div className="gp-fig"><span>تخفیف کارمزد انتخاب‌شده</span><strong dir="auto" data-testid="settlement-fee-discount">{signedDiscount}</strong></div>
      <div className="gp-fig teal"><span>مبلغ نهایی واریزی به مشتری</span><strong data-testid="settlement-final-payout">{toman(final.toString())}</strong></div>
    </div>
    {!valid && pending ? <p className="gp-alert" role="alert">مبلغ نهایی واریزی باید بیشتر از صفر و در محدودهٔ مجاز باشد.</p> : null}
    {pending ? <button className="btn btn-primary" disabled={!canSettle || busy || !valid}
      data-testid="button-settle" onClick={() => {
        if (confirm(`تسویه با واریزی نهایی ${toman(final.toString())} و تخفیف کارمزد ${signedDiscount} ثبت شود؟ پس از تسویه، این مبلغ قابل تغییر نیست.`)) onSettle(discount.toString());
      }}>{canSettle ? busy ? 'در حال ثبت تسویه…' : 'ثبت تسویه' : 'نیازمند دسترسی مالی'}</button> : null}
  </div>;
}

function Amount({ label, value }: { label: string; value?: string | null }) {
  return <div className="gp-fig"><span>{label}</span><strong>{toman(value)}</strong></div>;
}