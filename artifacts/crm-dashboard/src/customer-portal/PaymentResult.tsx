// «نتیجه‌ی پرداخت» after the gateway (HANDOFF part 2 §3). Data comes from the public receipt endpoint
// (status credited | reconciliation | pending | cancelled | failed, amountToman, providerRefId, paidAt, updatedAt,
// gatewayMessage); polling stays in WalletTopUp. Older servers omit the new fields: the «زمان» row then hides itself.
import { AlertCircle, ArrowLeft, Check, Clock, RefreshCw, Search, X } from 'lucide-react';
import { receiptTime } from './receipt-time';
import { ExpertPickerButton } from './ExpertPicker';
import { Icon } from './PortalUi';
import { Toman } from './Portal2Ui';
import { paymentReturnPath } from './payment-return';
import logoUrl from './assets/nafis-logo-full.svg';
import './nfp.css';
import './nfp2.css';

export type ReceiptData = { amountToman?: string; status?: string; providerRefId?: string | null; paidAt?: string | null; updatedAt?: string | null; gatewayMessage?: string | null };
const base = () => import.meta.env.BASE_URL.replace(/\/$/, '');

export function PaymentResult({ data, loading, onRefresh }: { data: ReceiptData | null; loading: boolean; onRefresh: () => void }) {
  const ret = paymentReturnPath();
  const retUrl = ret ? new URL(ret, window.location.origin) : null;
  const feePlan = retUrl && retUrl.searchParams.get('from') === 'fee' && /^\d+$/.test(retUrl.searchParams.get('planId') ?? '') ? retUrl.searchParams.get('planId') : null;
  const st = !data ? 'notfound' : data.status === 'credited' ? 'ok' : data.status === 'reconciliation' ? 'recon' : data.status === 'cancelled' ? 'cancel' : data.status === 'failed' ? 'failed' : 'pending';
  const amount = data?.amountToman && /^\d+$/.test(data.amountToman) ? Number(data.amountToman) : null;
  const wait = st === 'pending' || st === 'recon';
  const cfg = {
    ok: { cls: '', icon: Check, h: 'کیف پول شارژ شد', p: 'به موجودی نقدی شما اضافه شد.' },
    pending: { cls: ' nfp-wait', icon: Clock, h: 'پرداخت در حال تأیید است', p: 'این صفحه هر چند ثانیه خودکار به‌روز می‌شود. لازم نیست دوباره پرداخت کنید.' },
    recon: { cls: ' nfp-wait', icon: Clock, h: 'پرداخت دریافت شد؛ در حال ثبت نهایی', p: 'به‌زودی به موجودی شما اضافه می‌شود. این صفحه خودکار به‌روز می‌شود.' },
    cancel: { cls: ' nfp-bad', icon: X, h: 'پرداخت لغو شد', p: 'پرداخت را لغو کردید و مبلغی کم نشد.' },
    failed: { cls: ' nfp-bad', icon: X, h: 'پرداخت انجام نشد', p: 'مبلغی به کیف پول اضافه نشد. اگر از حساب بانکی‌تان کم شده، معمولاً بانک آن را برمی‌گرداند.' },
    notfound: { cls: ' nfp-bad', icon: Search, h: 'رسید پرداخت پیدا نشد', p: 'اگر پرداخت کرده‌اید، موجودی کیف پول را ببینید یا با کارشناس تماس بگیرید.' },
  }[st];
  const wallet = `${base()}/customer/wallet`;
  const retry = `${base()}${ret && /^\/customer\/wallet\/top-up/.test(ret) ? ret : '/customer/wallet/top-up'}`;
  const time = receiptTime(st === 'ok' ? data?.paidAt ?? data?.updatedAt : data?.updatedAt);
  return <div className="nfp" dir="rtl" data-testid={`page-payment-result-${st}`}>
    <header className="nfp-res-hd"><a href={`${base()}/customer`} aria-label="نفیس وام — خانه"><img src={logoUrl} alt="نفیس وام" /></a></header>
    <main className="nfp-wrap"><div className="nfp-mw"><section className="nfp-card">
      {loading && !data ? <div className="nfp-res nfp-wait" role="status"><span className="nfp-big"><Icon icon={RefreshCw} /></span><h1>در حال دریافت نتیجه‌ی پرداخت…</h1></div> :
      <div className={`nfp-res${cfg.cls}`} role={st === 'ok' ? 'status' : 'alert'} aria-live="polite">
        <span className="nfp-big"><Icon icon={st === 'notfound' ? AlertCircle : cfg.icon} /></span>
        <h1>{cfg.h}</h1>
        {amount != null && st !== 'notfound' && <div className="nfp-amount" data-testid="text-payment-amount"><Toman value={amount} /></div>}
        <p>{cfg.p}</p>
        {wait && <p className="nfp-muted" role="status"><Icon icon={RefreshCw} small /> بررسی دوباره تا چند ثانیه‌ی دیگر</p>}
        {st !== 'notfound' && <div className="nfp-sum">
          {(st === 'ok' || st === 'recon') && data?.providerRefId && <div><span>کد پیگیری</span><b><bdi>{data.providerRefId}</bdi></b></div>}
          {time && <div data-testid="row-payment-time"><span>زمان</span><b>{time}</b></div>}
          <div><span>درگاه</span><b>زرین‌پال</b></div>
          {st === 'failed' && <div data-testid="row-payment-gateway-message"><span>پیام درگاه</span><b>{data?.gatewayMessage || 'درگاه پرداخت این پرداخت را تأیید نکرد.'}</b></div>}</div>}
        <div className="nfp-btn-row">
          {st === 'ok' && feePlan && <a className="nf-btn nf-btn--primary nf-btn--block" href={`${base()}/customer/wallet/fee?planId=${feePlan}`} data-testid="link-payment-fee-continue">ادامه‌ی پرداخت هزینه تشکیل پرونده<Icon icon={ArrowLeft} small /></a>}
          {wait && <button type="button" className="nf-btn nf-btn--secondary nf-btn--block" onClick={onRefresh} disabled={loading} data-testid="button-payment-refresh"><Icon icon={RefreshCw} small />به‌روزرسانی</button>}
          {(st === 'cancel' || st === 'failed') && <a className="nf-btn nf-btn--primary nf-btn--block" href={retry} data-testid="link-payment-retry">{st === 'failed' && <Icon icon={RefreshCw} small />}پرداخت دوباره</a>}
          <a className={`nf-btn nf-btn--block ${st === 'ok' && !feePlan ? 'nf-btn--primary' : st === 'failed' ? 'nf-btn--text' : 'nf-btn--secondary'}`} href={wallet} data-testid="link-payment-wallet">رفتن به کیف پول</a>
          {(st === 'notfound' || st === 'failed') && <ExpertPickerButton label="تماس با کارشناس" ariaLabel="تماس با کارشناس فروش" className="nf-btn nf-btn--text nf-btn--block" testId="button-payment-expert" />}
        </div>
      </div>}
    </section></div></main>
  </div>;
}
