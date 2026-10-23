import { useRef, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { createCompanyWalletAdjustment, getGetCompanyWalletQueryKey, useGetCompanyWallet } from '@workspace/api-client-react';
import { Link } from 'wouter';

const money = (value: string) => BigInt(value).toLocaleString('fa-IR');

export default function CompanyWalletPanel() {
  const queryClient = useQueryClient();
  const { data, isLoading, isError, refetch } = useGetCompanyWallet({ query: { queryKey: getGetCompanyWalletQueryKey(), refetchInterval: 30_000, staleTime: 0 } });
  const [walletType, setWalletType] = useState<'cash' | 'credit'>('cash');
  const [direction, setDirection] = useState<'deposit' | 'withdrawal'>('deposit');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const key = useRef<string | null>(null);
  const resetKey = () => { key.current = null; setMessage(''); };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (pending || !/^[1-9]\d*$/.test(amount) || reason.trim().length < 3) return;
    setPending(true);
    setMessage('');
    key.current ??= crypto.randomUUID();
    try {
      await createCompanyWalletAdjustment({ walletType, direction, amountToman: amount, reason: reason.trim() },
        { headers: { 'Idempotency-Key': key.current } });
      await queryClient.invalidateQueries({ queryKey: getGetCompanyWalletQueryKey() });
      setAmount(''); setReason(''); key.current = null;
      setMessage('تراکنش دستی ثبت شد.');
    } catch (error) {
      const detail = error as { data?: { error?: string } };
      setMessage(detail.data?.error === 'insufficient_balance' ? 'موجودی کیف پول برای برداشت کافی نیست.' : 'ثبت تراکنش انجام نشد. دوباره تلاش کنید.');
    } finally { setPending(false); }
  };

  if (isLoading) return <div className="panel" style={{ padding: 24 }}>در حال دریافت کیف پول شرکت...</div>;
  if (isError || !data) return <div className="panel" style={{ padding: 24 }}>دریافت کیف پول شرکت ناموفق بود. <button type="button" onClick={() => refetch()}>تلاش دوباره</button></div>;
  return <div style={{ display: 'grid', gap: 18 }}>
    <div className="panel" style={{ padding: 20, display: 'flex', gap: 28, flexWrap: 'wrap' }}>
      <div>کیف پول نقدی نفیس وام<strong style={{ display: 'block', fontSize: 22 }}>{money(data.cashBalanceToman)} تومان</strong></div>
      <div>کیف پول اعتباری نفیس وام<strong style={{ display: 'block', fontSize: 22 }}>{money(data.creditBalanceToman)} تومان</strong></div>
    </div>
    <form className="panel" style={{ padding: 20, display: 'grid', gap: 12 }} onSubmit={submit}>
      <h3>ثبت دستی دریافت یا برداشت شرکت</h3>
      <p>این ثبت، تراکنش بانکی یا تبدیل وجه نقد به اعتبار انجام نمی‌دهد؛ فقط مانده انتخاب‌شده را با شرح اجباری اصلاح می‌کند.</p>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <label>کیف پول
          <select value={walletType} onChange={(e) => { resetKey(); setWalletType(e.target.value as 'cash' | 'credit'); }}>
            <option value="cash">نقدی</option><option value="credit">اعتباری</option>
          </select>
        </label>
        <label>نوع عملیات
          <select value={direction} onChange={(e) => { resetKey(); setDirection(e.target.value as 'deposit' | 'withdrawal'); }}>
            <option value="deposit">دریافت / افزایش</option><option value="withdrawal">برداشت / کاهش</option>
          </select>
        </label>
        <label>مبلغ (تومان)
          <input required inputMode="numeric" value={amount} onChange={(e) => { resetKey(); setAmount(e.target.value.replace(/\D/g, '').slice(0, 30)); }} />
        </label>
      </div>
      <label>شرح و مستند عملیات
        <input required minLength={3} maxLength={500} value={reason} onChange={(e) => { resetKey(); setReason(e.target.value); }} />
      </label>
      <button className="btn btn-primary" type="submit" disabled={pending || !/^[1-9]\d*$/.test(amount) || reason.trim().length < 3}>
        {pending ? 'در حال ثبت...' : 'ثبت تراکنش دستی'}
      </button>
      {message && <p role="status">{message}</p>}
    </form>
    <div className="panel" style={{ padding: 20 }}>
      <h3>سوابق کیف پول شرکت</h3>
      {!data.entries.length ? <p>تراکنشی ثبت نشده است.</p> : <div style={{ overflowX: 'auto' }}><table className="wallet-table">
        <thead><tr><th>زمان</th><th>کیف پول</th><th>نوع</th><th>مبلغ (تومان)</th><th>شرح / مشتری</th><th>ثبت‌کننده</th></tr></thead>
        <tbody>{data.entries.map((entry) => {
          const customerSalespersonName = (entry as typeof entry & { customerSalespersonName?: string | null }).customerSalespersonName;
          return <tr key={entry.id}>
          <td>{new Date(entry.createdAt).toLocaleString('fa-IR')}</td>
          <td>{entry.walletType === 'cash' ? 'نقدی' : 'اعتباری'}</td>
          <td>{entry.kind === 'goods_purchase' ? 'دریافت خالص خرید' : entry.kind === 'filing_fee' ? 'هزینه تشکیل پرونده' : entry.kind === 'manual_deposit' ? 'دریافت دستی' : 'برداشت دستی'}</td>
          <td>{entry.kind === 'manual_withdrawal' ? '−' : '+'}{money(entry.amountToman)}</td>
          <td>{entry.customerId ? <><Link href={`/customers/${entry.customerId}`}>{entry.customerName || `مشتری ${entry.customerId}`}</Link>
            <span style={{ display: 'block', fontSize: 11, color: '#64748b' }}>کارشناس فروش: {customerSalespersonName || 'بدون تخصیص'}</span>
            {entry.reason && <span style={{ display: 'block', fontSize: 11 }}>{entry.reason}</span>}
          </> : entry.reason || '—'}</td>
          <td>{entry.actorName || '—'}</td>
        </tr>;
        })}</tbody>
      </table></div>}
    </div>
  </div>;
}