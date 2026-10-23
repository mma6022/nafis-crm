// «کیف پول» (HANDOFF part 2 §3). Top-up moved to its own wizard page (WalletFlows.tsx); transfer keeps its sheet.
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'wouter';
import { AlertCircle, ArrowDownLeft, ArrowLeftRight, ArrowUpRight, Check, Plus, Receipt as ReceiptIcon, RefreshCw } from 'lucide-react';
import { portalApi, PortalApiError, type WalletTransaction } from './api';
import { BottomSheet } from './BottomSheet';
import { Icon } from './PortalUi';
import { Crumb, HelpCard, Toman } from './Portal2Ui';
import { findFeeDraft } from './fee-draft';

const digits = (v: string) => v.replace(/[۰-۹]/g, c => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(c))).replace(/[٠-٩]/g, c => String('٠١٢٣٤٥٦٧٨٩'.indexOf(c))).replace(/[,\s٬]/g, '');
const msg = (e: unknown) => e instanceof Error ? e.message : 'درخواست انجام نشد.';
const money = (v: string | number | null | undefined) => { try { return v == null ? '—' : BigInt(String(v)).toLocaleString('fa-IR'); } catch { return '—'; } };
const num = (v: string | number | null | undefined) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const kindLabels: Record<string, string> = { top_up: 'شارژ آنلاین', transfer_in: 'انتقال دریافتی', transfer_out: 'انتقال ارسالی', filing_fee: 'هزینه تشکیل پرونده' };
const newKey = () => crypto.randomUUID();
export const dayLabel = (v: string) => {
  const d = new Date(v); const today = new Date(); const y = new Date(); y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'امروز';
  if (d.toDateString() === y.toDateString()) return 'دیروز';
  return new Intl.DateTimeFormat('fa-IR-u-ca-persian', { day: 'numeric', month: 'long', year: 'numeric' }).format(d);
};
const clock = (v: string) => new Date(v).toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' });

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

function TxRow({ t }: { t: WalletTransaction }) {
  const label = kindLabels[t.kind] || t.description || 'تراکنش';
  const sub = [t.walletType === 'credit' ? 'اعتبار' : 'نقدی', kindLabels[t.kind] && t.description ? t.description : '', clock(t.createdAt)].filter(Boolean).join(' · ');
  return <div className={`nfp-tx${t.direction === 'out' ? ' nfp-out' : ''}`} role="listitem"><span className="nfp-ic" aria-hidden="true"><Icon icon={t.direction === 'in' ? ArrowDownLeft : ArrowUpRight} /></span>
    <span className="nfp-t"><b>{label}</b><small>{sub}</small></span><span className="nfp-a"><bdi>{t.direction === 'in' ? '+' : '−'}{money(t.amountToman)}</bdi><span className="nfp-sr"> تومان {t.direction === 'in' ? 'واریز' : 'برداشت'}</span></span></div>;
}

function Ledger() {
  const q = useInfiniteQuery({
    queryKey: ['customer', 'wallet-transactions'],
    queryFn: ({ pageParam }: { pageParam: string | undefined }) => portalApi.walletTransactions(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: last => last.nextCursor ?? undefined,
  });
  const { hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage } = q;
  const items = useMemo(() => {
    const seen = new Map<number, WalletTransaction>();
    q.data?.pages.forEach(p => p.items.forEach(i => { if (!seen.has(i.id)) seen.set(i.id, i); }));
    return [...seen.values()];
  }, [q.data]);
  const groups = useMemo(() => {
    const out: Array<[string, WalletTransaction[]]> = [];
    items.forEach(t => { const d = dayLabel(t.createdAt); const last = out[out.length - 1]; if (last && last[0] === d) last[1].push(t); else out.push([d, [t]]); });
    return out;
  }, [items]);
  let body;
  if (q.isLoading) body = <div className="nfp-list" aria-busy="true" role="status" aria-label="در حال دریافت تراکنش‌ها">{[1, 2, 3, 4].map(i => <div key={i} className="nfp-tx"><span className="nfp-sk" style={{ width: 40, height: 40, borderRadius: 12 }} /><span className="nfp-t"><span className="nfp-sk" style={{ height: 14, width: '50%' }} /><span className="nfp-sk" style={{ height: 12, width: '30%', marginTop: 6 }} /></span><span className="nfp-sk" style={{ height: 16, width: 80 }} /></div>)}</div>;
  else if (q.isError && !items.length) body = <div className="nfp-empty nfp-err" role="alert"><span className="nfp-big"><Icon icon={AlertCircle} /></span><h2>تراکنش‌ها بارگیری نشد</h2><p>{msg(q.error)}</p><button type="button" className="nf-btn nf-btn--secondary" onClick={() => void q.refetch()} data-testid="button-retry-ledger"><Icon icon={RefreshCw} small />تلاش دوباره</button></div>;
  else if (!items.length) body = <div className="nfp-empty"><span className="nfp-big"><Icon icon={ReceiptIcon} /></span><h2>هنوز تراکنشی ندارید</h2><p>بعد از اولین شارژ یا پرداخت، همه‌ی واریزها و برداشت‌ها همین‌جا نشان داده می‌شود.</p></div>;
  else body = <><div role="list" data-testid="list-wallet-transactions">{groups.map(([d, rows]) => <div key={d} style={{ display: 'contents' }}><div className="nfp-tx-day" role="presentation">{d}</div>{rows.map(t => <TxRow key={t.id} t={t} />)}</div>)}</div>
    <div className="nfp-more">{isFetchNextPageError ? <div className="nfp-alert" role="alert"><Icon icon={AlertCircle} small /><span>تراکنش‌های قدیمی‌تر دریافت نشد.</span><button type="button" className="nf-btn nf-btn--secondary nf-btn--sm" onClick={() => void fetchNextPage()} data-testid="button-retry-older">تلاش دوباره</button></div>
      : isFetchingNextPage ? <span className="nfp-muted" role="status"><Icon icon={RefreshCw} small />در حال دریافت…</span>
      : hasNextPage ? <button type="button" className="nf-btn nf-btn--text" onClick={() => void fetchNextPage()} data-testid="button-load-older">نمایش قدیمی‌تر</button> : null}</div></>;
  return <section className="nfp-card" aria-labelledby="ledger-title"><div className="nfp-sec-t" style={{ margin: 0 }}><h2 id="ledger-title">تراکنش‌ها</h2></div>{body}</section>;
}

/** «هزینه تشکیل پرونده» card: only while a loan request draft exists and its fee is unpaid. */
function FeeCard() {
  const me = useQuery({ queryKey: ['customer', 'me'], queryFn: portalApi.me, retry: false });
  const draft = me.data?.id ? findFeeDraft(me.data.id) : null;
  const intake = useQuery({ queryKey: ['customer', 'intake', draft?.planId], queryFn: () => portalApi.intakeStatus(draft!.planId), enabled: !!draft, retry: false });
  const fee = intake.data?.filingFeeToman;
  if (!draft || !intake.data || intake.data.feeChargeId != null || !/^\d+$/.test(String(fee ?? '')) || num(fee) <= 0) return null;
  return <section className="nfp-fee" aria-labelledby="fee-card-t" data-testid="card-wallet-fee"><span className="nfp-ic" aria-hidden="true"><Icon icon={ReceiptIcon} /></span>
    <span className="nfp-t"><b id="fee-card-t">هزینه تشکیل پرونده</b><span className="nfp-num"><Toman value={num(fee)} /></span></span>
    <Link className="nf-btn nf-btn--gold" href={`/customer/wallet/fee?planId=${draft.planId}`} data-testid="link-wallet-fee">پرداخت</Link></section>;
}

export function WalletPanel() {
  const wallet = useQuery({ queryKey: ['customer', 'wallet'], queryFn: portalApi.wallet });
  const [sheet, setSheet] = useState(false);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const cash = wallet.data ? String(wallet.data.cashBalanceToman) : null;
  const bal = wallet.isLoading ? <section className="nfp-bal nfp-sk-bal" aria-busy="true" aria-label="در حال دریافت موجودی"><span className="nfp-sk" style={{ height: 14, width: '30%' }} /><span className="nfp-sk" style={{ height: 40, width: '60%' }} /><span className="nfp-sk" style={{ height: 52 }} /><div className="nfp-bal-acts"><span className="nfp-sk" style={{ height: 52 }} /><span className="nfp-sk" style={{ height: 52 }} /></div></section>
    : wallet.isError ? <div className="nfp-card"><div className="nfp-empty nfp-err" role="alert"><span className="nfp-big"><Icon icon={AlertCircle} /></span><h2>موجودی کیف پول بارگیری نشد</h2><p>{msg(wallet.error)}</p><button type="button" className="nf-btn nf-btn--secondary" onClick={() => void wallet.refetch()} data-testid="button-retry-wallet"><Icon icon={RefreshCw} small />تلاش دوباره</button></div></div>
    : <section className="nfp-bal" aria-labelledby="bal-l"><div><div className="nfp-lb" id="bal-l">موجودی نقدی</div><div className="nfp-v" data-testid="text-wallet-balance"><Toman value={num(cash)} /></div></div>
      <div className="nfp-cr"><span>اعتبار<small>فقط برای خرید؛ قابل انتقال نیست</small></span><b data-testid="text-wallet-credit"><Toman value={num(wallet.data?.creditBalanceToman)} /></b></div>
      <div className="nfp-bal-acts"><Link className="nf-btn nf-btn--primary" href="/customer/wallet/top-up" data-testid="button-open-topup"><Icon icon={Plus} small />شارژ</Link>
        <button type="button" className="nf-btn nf-btn--ghost2" aria-haspopup="dialog" aria-controls="sheet-transfer" aria-expanded={sheet} onClick={() => { setReceipt(null); setSheet(true); }} data-testid="button-open-transfer"><Icon icon={ArrowLeftRight} small />انتقال</button></div></section>;
  return <div className="nfp-stack" data-testid="page-wallet">
    <Crumb items={[['خانه', '/customer'], ['کیف پول']]} />
    <h1 className="nfp-h1">کیف پول</h1>
    <div className="nfp-w-grid"><div className="nfp-stack">
      {bal}
      {receipt && <div className="nfp-alert nfp-ok" role="status" data-testid="panel-transfer-receipt"><Icon icon={Check} small /><span><b>انتقال انجام شد.</b> {money(receipt.amount)} تومان به {receipt.name} · رسید شماره {Number(receipt.id).toLocaleString('fa-IR')}</span>
        <button type="button" className="nf-btn nf-btn--text nf-btn--sm" onClick={() => setReceipt(null)} data-testid="button-dismiss-receipt">بستن</button></div>}
      {wallet.isSuccess && <FeeCard />}
      {!wallet.isError && <Ledger />}
    </div><div className="nfp-w-side"><HelpCard title="سؤال درباره‌ی پرداخت؟" id="nfp-hc-wallet" /></div></div>
    <TransferSheet open={sheet} onClose={() => setSheet(false)} cash={cash} onDone={r => { setSheet(false); setReceipt(r); }} />
  </div>;
}
