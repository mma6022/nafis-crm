import { AlertTriangle, Check, Clock3, X } from 'lucide-react';
import type { WalletPaymentResult as PaymentResult } from '@workspace/api-client-react';
import { Modal } from './DataTools';
import './WalletPaymentResult.css';

type Props = {
  result?: PaymentResult;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  onClose: () => void;
};

export function WalletPaymentResult({ result, loading, error, onRetry, onClose }: Props) {
  const status = error ? 'error' : result?.status ?? 'created';
  const success = status === 'credited';
  const cancelled = status === 'cancelled';
  const failed = status === 'failed';
  const heading = loading ? 'در حال بررسی پرداخت' : success ? 'پرداخت با موفقیت انجام شد' : cancelled ? 'پرداخت لغو شد' : failed ? 'پرداخت ناموفق بود' : 'وضعیت پرداخت نیازمند بررسی است';
  const description = loading
    ? 'لطفاً کمی صبر کنید تا وضعیت تراکنش از سرور دریافت شود.'
    : success
      ? 'مبلغ پرداخت‌شده به کیف پول نقدی مشتری اضافه شد.'
      : cancelled
        ? 'پرداخت تکمیل نشده و موجودی کیف پول تغییری نکرده است.'
        : failed
          ? 'درگاه پرداخت را تأیید نکرده و موجودی کیف پول تغییری نکرده است.'
          : error
            ? 'دریافت وضعیت تراکنش ممکن نشد. لطفاً دوباره بررسی کنید و تا مشخص‌شدن نتیجه، پرداخت تازه‌ای انجام ندهید.'
            : 'تأیید نهایی یا ثبت شارژ هنوز مشخص نیست. تا روشن‌شدن نتیجه، پرداخت تازه‌ای انجام ندهید.';
  const tone = loading || (!success && !cancelled && !failed) ? 'pending' : success ? 'success' : 'negative';

  return <Modal title="نتیجه پرداخت" eyebrow="شارژ کیف پول نقدی" onClose={onClose} testId="wallet-payment-result">
    <div className={`wallet-payment-result wallet-payment-result--${tone}`} role="status" aria-live="polite">
      <div className="wallet-payment-result-icon" aria-hidden="true">
        {success ? <Check size={27} strokeWidth={2.5} /> : cancelled || failed ? <X size={27} strokeWidth={2.5} /> : loading ? <Clock3 size={27} /> : <AlertTriangle size={27} />}
      </div>
      <h4>{heading}</h4>
      <p>{description}</p>
      {result && <div className="wallet-payment-result-details">
        <div><span>مبلغ تراکنش</span><strong>{BigInt(result.amountToman).toLocaleString('fa-IR')} تومان</strong></div>
        <div><span>شماره پیگیری داخلی</span><strong>#{result.id.toLocaleString('fa-IR')}</strong></div>
      </div>}
      <div className="wallet-payment-result-actions">
        {!loading && !success && !cancelled && !failed && <button type="button" className="btn btn-ghost" onClick={onRetry}>بررسی دوباره وضعیت</button>}
        <button type="button" className="btn btn-primary" onClick={onClose}>بازگشت به پرونده مشتری</button>
      </div>
    </div>
  </Modal>;
}