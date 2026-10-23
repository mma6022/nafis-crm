import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, Copy, RefreshCw, ShieldCheck, X } from 'lucide-react';
import { paymentReturnPath } from '../customer-portal/payment-return';

type ShareLinkData = {
  customerName: string;
  amountToman: string;
  planName?: string | null;
  status: string;
  paymentIntentId?: number | string | null;
};

const statusText: Record<string, string> = {
  credited: 'پرداخت با موفقیت انجام و مبلغ به کیف پول مشتری اضافه شده است.',
  cancelled: 'این پرداخت لغو شده است.',
  failed: 'پرداخت ناموفق بود و مبلغی به کیف پول اضافه نشده است.',
  pending: 'پرداخت هنوز نهایی نشده است.',
  reconciliation: 'پرداخت دریافت شده و در حال تطبیق نهایی است.',
};
const knownStatuses = new Set(['created', 'pending', 'credited', 'cancelled', 'failed', 'reconciliation']);
function publicWalletError(value: unknown) {
  const text = typeof value === 'string' ? value : '';
  if (/expired|invalid|not found|منقضی|نامعتبر/i.test(text)) return 'این لینک شارژ نامعتبر یا منقضی شده است. از فرستنده لینک جدید بخواهید.';
  return text || 'دریافت اطلاعات لینک انجام نشد. دوباره تلاش کنید.';
}

export default function WalletTopUp() {
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const token = params.get('token') || /\/(~[A-Za-z0-9_-]{14})\/?$/.exec(window.location.pathname)?.[1] || '';
  const receipt = params.get('receipt') || '';
  const [data, setData] = useState<ShareLinkData | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [declined, setDeclined] = useState(false);
  const inFlight = useRef(false);

  const load = useCallback(async (background = false) => {
    if (inFlight.current) return;
    if (!token && !receipt) { setError('لینک شارژ معتبر نیست.'); setLoading(false); return; }
    inFlight.current = true;
    if (!background) setLoading(true);
    setError('');
    try {
      const query = new URLSearchParams();
      for (const key of ['customerId', 'amountToman', 'planId', 'paymentIntent']) {
        const value = params.get(key);
        if (value) query.set(key, value);
      }
      const base = import.meta.env.BASE_URL.replace(/\/$/, '');
      const endpoint = receipt ? `${base}/api/wallet/share-links/receipt/${encodeURIComponent(receipt)}`
        : `${base}/api/wallet/share-links/${encodeURIComponent(token)}${query.toString() ? `?${query}` : ''}`;
      const response = await fetch(endpoint, { credentials: 'omit' });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(publicWalletError(body.error));
      setData(body);
    } catch (e) { setError(publicWalletError(e instanceof Error ? e.message : '')); }
    finally { inFlight.current = false; setLoading(false); }
  }, [params, token, receipt]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!receipt || !data || !['pending', 'reconciliation'].includes(data.status)) return;
    const timer = window.setInterval(() => { void load(true); }, 5000);
    return () => window.clearInterval(timer);
  }, [receipt, data?.status, load]);
  useEffect(() => {
    const meta = document.createElement('meta');
    // Zarinpal checks the referring domain. Send only the origin so the
    // private share token and customer/amount query never reach the gateway.
    meta.name = 'referrer'; meta.content = 'origin';
    document.head.appendChild(meta);
    return () => { meta.remove(); };
  }, []);
  const amount = data?.amountToman ? BigInt(data.amountToman).toLocaleString('fa-IR') : '';
  const normalizedStatus = data?.status && knownStatuses.has(data.status) ? data.status : 'pending';
  const finalStatus = Boolean(data && (receipt || normalizedStatus !== 'created'));

  const startPayment = async () => {
    setStarting(true); setError('');
    try {
      const query = new URLSearchParams();
      for (const key of ['customerId', 'amountToman', 'planId']) {
        const value = params.get(key);
        if (value) query.set(key, value);
      }
      const response = await fetch(`/api/wallet/share-links/${encodeURIComponent(token)}/start${query.toString() ? `?${query}` : ''}`, { method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !body.paymentUrl) throw new Error(publicWalletError(body.error || 'شروع پرداخت امکان‌پذیر نیست.'));
      window.location.assign(body.paymentUrl);
    } catch (e) { setError(e instanceof Error ? e.message : 'شروع پرداخت انجام نشد.'); setStarting(false); }
  };

  return <main className="wallet-topup-page" dir="rtl">
    <div className="wallet-topup-card">
      <div className="wallet-topup-brand"><ShieldCheck size={22} /> شارژ کیف پول</div>
      {loading ? <div className="wallet-topup-state">در حال دریافت اطلاعات لینک…</div> : error && !data ? <div className="wallet-topup-error"><strong>لینک قابل استفاده نیست</strong><span>{error}</span></div> : declined ? <div className="wallet-topup-state"><X size={28} /><strong>این درخواست رد شد</strong><span>هیچ درگاهی باز نشد و مبلغی از شما دریافت نمی‌شود.</span></div> : data && <>
        <h1>{receipt ? 'نتیجه پرداخت شارژ کیف پول' : `شارژ کیف پول ${data.customerName}`}</h1>
        <div className="wallet-topup-amount"><span>{receipt ? 'مبلغ تراکنش' : 'مبلغ قابل پرداخت'}</span><strong>{amount} <small>تومان</small></strong></div>
        {data.planName && <div className="wallet-topup-plan">طرح تسهیلات: <strong>{data.planName}</strong></div>}
        {error && <div className="wallet-topup-error" role="alert"><span>{error}</span></div>}
        {finalStatus ? <div className={`wallet-topup-status status-${normalizedStatus}`}>{normalizedStatus === 'credited' ? <Check size={20} /> : <RefreshCw size={20} />}<span>{statusText[normalizedStatus] || 'وضعیت پرداخت در حال بررسی است.'}</span></div> : <p className="wallet-topup-note">با تأیید، به درگاه پرداخت امن منتقل می‌شوید. پس از بازگشت، وضعیت واقعی پرداخت نمایش داده خواهد شد.</p>}
        {!finalStatus && <div className="wallet-topup-actions"><button className="btn btn-primary" onClick={startPayment} disabled={starting}>تایید و ورود به درگاه</button><button className="btn btn-ghost" onClick={() => setDeclined(true)}><X size={16} /> رد کردن</button></div>}
        {finalStatus && <button className="btn btn-ghost wallet-topup-refresh" onClick={() => void load()} disabled={loading}><RefreshCw size={16} /> به‌روزرسانی وضعیت</button>}
      </>}
      {error && <button className="btn btn-ghost wallet-topup-refresh" onClick={() => void load()}><RefreshCw size={16} /> تلاش دوباره</button>}
      <div className="wallet-topup-actions" style={{ marginTop: 20, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        {paymentReturnPath() && <a className="btn btn-primary" href={`${import.meta.env.BASE_URL.replace(/\/$/, '')}${paymentReturnPath()}`} data-testid="link-payment-return">بازگشت به صفحه قبل از پرداخت</a>}
        <a className="btn btn-ghost" href={`${import.meta.env.BASE_URL.replace(/\/$/, '')}/customer`} data-testid="link-payment-panel">بازگشت به پنل مشتری</a>
      </div>
    </div>
  </main>;
}