import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeftRight, ArrowDownLeft, ArrowUpRight, Check, Plus, RefreshCw } from 'lucide-react';
import { portalApi, PortalApiError } from './api';
import { BottomSheet } from './BottomSheet';

const digits = (v: string) => v.replace(/[۰-۹]/g, c => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(c))).replace(/[٠-٩]/g, c => String('٠١٢٣٤٥٦٧٨٩'.indexOf(c))).replace(/[,\s٬]/g, '');
const msg = (e: unknown) => e instanceof Error ? e.message : 'درخواست انجام نشد.';
const money = (v: string | number | null | undefined) => { try { return v == null ? '—' : BigInt(String(v)).toLocaleString('fa-IR'); } catch { return '—'; } };
const kindLabels: Record<string, string> = { top_up: 'شارژ کیف پول', transfer_in: 'انتقال دریافتی', transfer_out: 'انتقال ارسالی', filing_fee: 'هزینه تشکیل پرونده' };
const newKey = () => crypto.randomUUID();

function TopUpSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [amount, setAmount] = useState('');
  const [error, setError] = useState('');
  const topUp = useMutation({ mutationFn: (a: string) => portalApi.topUpAndPay(a), retry: false });
  const { reset } = topUp;
  useEffect(() => { if (open) { setAmount(''); setError(''); reset(); } }, [open, reset]);
  const locked = topUp.isPending || topUp.isSuccess;
  const submit = (e: FormEvent) => {
    e.preventDefault(); if (locked) return; setError('');
    const value = digits(amount);
    if (!/^\d+$/.test(value) || BigInt(value) <= 0n) { setError('مبلغ شارژ را درست وارد کنید.'); return; }
    topUp.mutate(value, {
      onSuccess: r => {
        let url: URL | null = null;
        try { url = r?.paymentUrl ? new URL(r.paymentUrl) : null; } catch { url = null; }
        if (!r?.paymentUrl) { setError('لینک پرداخت از سرور دریافت نشد؛ شارژ انجام نشد. دوباره تلاش کنید.'); reset(); return; }
        if (!url || url.protocol !== 'https:') { setError('لینک پرداخت امن (https) نیست و باز نشد.'); reset(); return; }
        window.location.assign(url.href);
      },
      onError: err => setError(msg(err)),
    });
  };
  return <BottomSheet open={open} onClose={onClose} locked={locked} title="شارژ کیف پول" description="مبلغ را وارد کنید؛ برای پرداخت به درگاه بانکی منتقل می‌شوید." testId="sheet-topup">
    <form className="cp-form" onSubmit={submit}>
      <label className="cp-field">مبلغ (تومان)<input required autoFocus inputMode="numeric" dir="ltr" value={amount} onChange={e => { setAmount(e.target.value); setError(''); }} data-testid="input-topup-amount" /></label>
      {error && <div className="cp-alert" role="alert">{error}</div>}
      <button className="cp-btn cp-btn-primary" disabled={locked} data-testid="button-topup">{topUp.isPending ? 'در حال اتصال به درگاه…' : topUp.isSuccess ? 'انتقال به درگاه…' : 'پرداخت و شارژ'}</button>
    </form>
  </BottomSheet>;
}

type Receipt = { id: number; amount: string; name: string };
function TransferSheet({ open, onClose, cash, onDone }: { open: boolean; onClose: () => void; cash: string | null; onDone: (r: Receipt) => void }) {
  const queryClient = useQueryClient();
  const [mobile, setMobile] = useState('');
  const [amount, setAmount] = useState('');
  const [error, setError] = useState('');
  const keyRef = useRef(newKey());
  const find = useMutation({ mutationFn: (v: { mobile: string; amount: string }) => portalApi.findTransferRecipient(v.mobile, v.amount) });
  const send = useMutation({ mutationFn: (v: { token: string; amount: string; key: string }) => portalApi.transferCash({ recipientToken: v.token, amountToman: v.amount, confirmed: true, idempotencyKey: v.key }), retry: false });
  const lookup = find.data && find.isSuccess ? find.data : null;
  const { reset: resetFind } = find; const { reset: resetSend } = send;
  useEffect(() => { if (open) { setMobile(''); setAmount(''); setError(''); resetFind(); resetSend(); keyRef.current = newKey(); } }, [open, resetFind, resetSend]);
  const locked = find.isPending || send.isPending;
  const changed = () => { setError(''); resetFind(); resetSend(); keyRef.current = newKey(); };
  const validate = () => {
    const m = digits(mobile), a = digits(amount);
    if (!/^09\d{9}$/.test(m)) return 'شماره همراه گیرنده باید با ۰۹ آغاز شود و ۱۱ رقم داشته باشد.';
    if (!/^\d+$/.test(a) || BigInt(a) <= 0n) return 'مبلغ انتقال را درست وارد کنید.';
    if (cash == null || !/^\d+$/.test(cash)) return 'موجودی نقدی نامشخص است؛ دوباره تلاش کنید.';
    if (BigInt(a) > BigInt(cash)) return 'مبلغ بیشتر از موجودی نقدی شماست. اعتبار تسهیلات قابل انتقال نیست.';
    return '';
  };
  const search = (e: FormEvent) => {
    e.preventDefault(); if (locked) return;
    const problem = validate(); if (problem) { setError(problem); return; }
    setError(''); resetSend();
    find.mutate({ mobile: digits(mobile), amount: digits(amount) }, { onError: err => setError(err instanceof PortalApiError && err.status === 404 ? 'گیرنده‌ای با این شماره پیدا نشد.' : msg(err)) });
  };
  const confirm = () => {
    if (!lookup || locked) return; setError('');
    if (new Date(lookup.expiresAt).getTime() <= Date.now()) { resetFind(); resetSend(); setError('اعتبار تأیید گیرنده تمام شد؛ دوباره جستجو کنید.'); return; }
    send.mutate({ token: lookup.recipientToken, amount: lookup.amountToman, key: keyRef.current }, {
      onSuccess: r => {
        const receipt = { id: r.id, amount: r.amountToman, name: lookup.recipientName };
        keyRef.current = newKey();
        void queryClient.invalidateQueries({ queryKey: ['customer', 'wallet'] });
        void queryClient.resetQueries({ queryKey: ['customer', 'wallet-transactions'] });
        onDone(receipt);
      },
      onError: err => {
        const code = err instanceof PortalApiError ? err.code : undefined;
        if (['transfer_confirmation_expired', 'transfer_confirmation_mismatch', 'recipient_changed', 'transfer_already_confirmed'].includes(code ?? '')) {
          resetFind(); resetSend(); keyRef.current = newKey(); setError(msg(err));
          void queryClient.invalidateQueries({ queryKey: ['customer', 'wallet'] });
          void queryClient.resetQueries({ queryKey: ['customer', 'wallet-transactions'] });
        }
        else if (code === 'insufficient_cash_balance') {
          resetFind(); resetSend(); keyRef.current = newKey(); setError('موجودی نقدی برای این انتقال کافی نیست.');
          void queryClient.invalidateQueries({ queryKey: ['customer', 'wallet'] });
        }
        else if (err instanceof PortalApiError && err.status < 500) setError(msg(err));
        else setError(msg(err) + ' نتیجه انتقال نامشخص است؛ پیش از تلاش دوباره، تراکنش‌ها را بررسی کنید یا با همان درخواست دوباره تأیید بزنید.');
      },
    });
  };
  return <BottomSheet open={open} onClose={onClose} locked={locked} title="انتقال وجه نقدی" description="فقط از موجودی نقدی و با شماره همراه دقیق گیرنده." testId="sheet-transfer">
    <p className="cp-hint">موجودی نقدی قابل انتقال: <strong>{money(cash)} تومان</strong></p>
    <form className="cp-form" onSubmit={search}>
      <label className="cp-field">شماره همراه گیرنده<input required autoFocus type="tel" inputMode="tel" dir="ltr" placeholder="09120000000" value={mobile} onChange={e => { setMobile(e.target.value); changed(); }} data-testid="input-transfer-mobile" /></label>
      <label className="cp-field">مبلغ (تومان)<input required inputMode="numeric" dir="ltr" value={amount} onChange={e => { setAmount(e.target.value); changed(); }} data-testid="input-transfer-amount" /></label>
      {!lookup && <button className="cp-btn cp-btn-outline" disabled={locked} data-testid="button-transfer-lookup">{find.isPending ? 'در حال جستجو…' : 'جستجوی گیرنده'}</button>}
    </form>
    {lookup && <div className="cp-confirm" role="group" aria-label="تأیید نهایی انتقال" data-testid="panel-transfer-confirm">
      <small>انتقال به</small><strong>{lookup.recipientName}</strong>
      <dl><div><dt>مبلغ</dt><dd>{money(lookup.amountToman)} تومان</dd></div><div><dt>شماره</dt><dd dir="ltr">{digits(mobile)}</dd></div></dl>
      <button type="button" className="cp-btn cp-btn-primary" disabled={locked} onClick={confirm} data-testid="button-transfer-confirm">{send.isPending ? 'در حال انتقال…' : send.isError ? 'تأیید دوباره انتقال' : 'تأیید و انتقال'}</button>
    </div>}
    {error && <div className="cp-alert" role="alert" style={{ marginTop: 12 }} data-testid="text-transfer-error">{error}</div>}
  </BottomSheet>;
}

function Ledger() {
  const q = useInfiniteQuery({
    queryKey: ['customer', 'wallet-transactions'],
    queryFn: ({ pageParam }: { pageParam: string | undefined }) => portalApi.walletTransactions(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: last => last.nextCursor ?? undefined,
  });
  const sentinel = useRef<HTMLDivElement>(null);
  const { hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage } = q;
  const fetchRef = useRef(fetchNextPage); fetchRef.current = fetchNextPage;
  useEffect(() => {
    const node = sentinel.current;
    if (!node || !hasNextPage || isFetchingNextPage || isFetchNextPageError || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(entries => { if (entries[0]?.isIntersecting) { io.disconnect(); void fetchRef.current(); } }, { rootMargin: '200px' });
    io.observe(node);
    return () => io.disconnect();
  }, [hasNextPage, isFetchingNextPage, isFetchNextPageError]);
  const items = useMemo(() => {
    const seen = new Map<number, NonNullable<typeof q.data>['pages'][number]['items'][number]>();
    q.data?.pages.forEach(p => p.items.forEach(i => { if (!seen.has(i.id)) seen.set(i.id, i); }));
    return [...seen.values()];
  }, [q.data]);
  return <section className="cp-card" aria-labelledby="ledger-title"><h2 id="ledger-title">تراکنش‌ها</h2>
    {q.isLoading ? <div role="status" aria-label="در حال دریافت"><div className="cp-skeleton" /><div className="cp-skeleton" /></div>
      : q.isError && !items.length ? <div className="cp-alert" role="alert">{msg(q.error)} <button type="button" className="cp-btn cp-btn-outline cp-btn-small" onClick={() => void q.refetch()} data-testid="button-retry-ledger">تلاش دوباره <RefreshCw size={13} /></button></div>
      : !items.length ? <div className="cp-empty"><strong>هنوز تراکنشی ندارید</strong><p>شارژ، انتقال و هزینه‌ها در همین فهرست ثبت می‌شوند.</p></div>
      : <ul className="cp-ledger" data-testid="list-wallet-transactions">{items.map(t => <li key={t.id} className="cp-tx">
        <span className={`cp-tx-ico ${t.direction}`} aria-hidden="true">{t.direction === 'in' ? <ArrowDownLeft size={16} /> : <ArrowUpRight size={16} />}</span>
        <span className="cp-tx-main"><strong>{kindLabels[t.kind] || t.description || t.kind}</strong><small>{t.description && kindLabels[t.kind] ? t.description + ' · ' : ''}{t.walletType === 'credit' ? 'اعتبار' : 'نقدی'} · {new Date(t.createdAt).toLocaleString('fa-IR')}</small></span>
        <b className={`cp-tx-amt ${t.direction}`}>{t.direction === 'in' ? '+' : '−'}{money(t.amountToman)}</b>
      </li>)}</ul>}
    {items.length > 0 && <div ref={sentinel} className="cp-ledger-foot">
      {isFetchNextPageError ? <div className="cp-alert" role="alert">دریافت تراکنش‌های قدیمی‌تر ناموفق بود. <button type="button" className="cp-btn cp-btn-outline cp-btn-small" onClick={() => void fetchNextPage()} data-testid="button-retry-older">تلاش دوباره</button></div>
        : isFetchingNextPage ? <div className="cp-skeleton" role="status" aria-label="در حال دریافت" style={{ height: 52 }} />
        : hasNextPage ? <button type="button" className="cp-btn cp-btn-outline cp-btn-small" onClick={() => void fetchNextPage()} data-testid="button-load-older">نمایش قدیمی‌تر</button> : null}
    </div>}
  </section>;
}

export function WalletPanel({ embedded = false }: { embedded?: boolean }) {
  const wallet = useQuery({ queryKey: ['customer', 'wallet'], queryFn: portalApi.wallet });
  const [sheet, setSheet] = useState<'topup' | 'transfer' | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const cash = wallet.data ? String(wallet.data.cashBalanceToman) : null;
  return <div className={embedded ? 'cp-wallet-embedded' : undefined} style={embedded ? { marginBottom: 20 } : undefined} data-testid={embedded ? 'panel-wallet-home' : undefined}>
    {!embedded && <div className="cp-pagehead"><div><p className="cp-eyebrow">کیف پول</p><h1 className="cp-title">موجودی شما</h1></div></div>}
    {wallet.isError && <div className="cp-alert" role="alert" style={{ marginBottom: 14 }}>{msg(wallet.error)} <button type="button" className="cp-btn cp-btn-outline cp-btn-small" onClick={() => void wallet.refetch()} data-testid="button-retry-wallet">تلاش دوباره <RefreshCw size={13} /></button></div>}
    <div className="cp-stack">
      <div className="cp-balances">
        <section className="cp-bal cash"><p className="cp-eyebrow">نقدی</p>
          {wallet.isLoading ? <div className="cp-skeleton" role="status" aria-label="در حال دریافت" style={{ height: 34 }} /> : <p className="cp-bal-num" data-testid="text-wallet-balance">{money(cash)}<small> تومان</small></p>}
</section>
        <section className="cp-bal credit"><p className="cp-eyebrow">اعتبار</p>
          {wallet.isLoading ? <div className="cp-skeleton" role="status" aria-label="در حال دریافت" style={{ height: 34 }} /> : <p className="cp-bal-num" data-testid="text-wallet-credit">{wallet.isSuccess ? money(wallet.data.creditBalanceToman) : '—'}<small> تومان</small></p>}
          <p className="cp-hint">جدا از موجودی نقدی و غیرقابل انتقال</p></section>
      </div>
      <div className="cp-wallet-tools" role="toolbar" aria-label="عملیات کیف پول">
        <button type="button" className="cp-icon-act" aria-label="شارژ کیف پول" title="شارژ" aria-haspopup="dialog" aria-controls="sheet-topup" aria-expanded={sheet === 'topup'} onClick={() => setSheet('topup')} data-testid="button-open-topup"><Plus size={18} /><span>شارژ</span></button>
        <button type="button" className="cp-icon-act" aria-label="انتقال وجه نقدی" title="انتقال" aria-haspopup="dialog" aria-controls="sheet-transfer" aria-expanded={sheet === 'transfer'} disabled={!wallet.isSuccess} onClick={() => { setReceipt(null); setSheet('transfer'); }} data-testid="button-open-transfer"><ArrowLeftRight size={18} /><span>انتقال</span></button>
      </div>
      {receipt && <section className="cp-alert cp-alert-good" role="status" data-testid="panel-transfer-receipt"><strong><Check size={14} style={{ verticalAlign: 'middle' }} /> انتقال انجام شد</strong><br />{money(receipt.amount)} تومان به {receipt.name} · رسید شماره {Number(receipt.id).toLocaleString('fa-IR')}
        <button type="button" className="cp-btn cp-btn-outline cp-btn-small" style={{ marginInlineStart: 10 }} onClick={() => setReceipt(null)} data-testid="button-dismiss-receipt">بستن</button></section>}
      {!embedded && <Ledger />}
    </div>
    <TopUpSheet open={sheet === 'topup'} onClose={() => setSheet(null)} />
    <TransferSheet open={sheet === 'transfer'} onClose={() => setSheet(null)} cash={cash} onDone={r => { setSheet(null); setReceipt(r); }} />
  </div>;
}
