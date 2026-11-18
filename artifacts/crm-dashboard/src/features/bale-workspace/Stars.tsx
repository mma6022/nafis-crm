/* «فضای کار بله» ج — ستاره ۱ تا ۳ (نه اولویت). Attached to the customer, not to one bot chat. 44px targets. */
import { useState } from 'react';
import { bbFetch, BbError } from '@/features/bale-bot/api';
import { fd } from './api';

const Star = ({ on }: { on: boolean }) => <svg className={`bws-star${on ? ' on' : ''}`} viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.2l2.6 5.5 6 .8-4.4 4.1 1.1 6-5.3-2.9-5.3 2.9 1.1-6L3.4 9.5l6-.8z" /></svg>;
export function StarMark({ n, small = false }: { n: number; small?: boolean }) {
  if (!n) return null;
  return <span className={`bws-stars${small ? ' sm' : ''}`} aria-label={`${fd(n)} ستاره`} title={`${fd(n)} ستاره`}>{[1, 2, 3].map((i) => <Star key={i} on={i <= n} />)}</span>;
}
export function StarPicker({ chatId, value, onChange, toast, disabled }: { chatId: number; value: number; onChange: (n: number) => void; toast: (t: string) => void; disabled?: boolean }) {
  const [busy, setBusy] = useState(false);
  const set = async (n: number) => {
    const next = n === value ? 0 : n; setBusy(true);
    try { const r = await bbFetch<{ stars: number }>(`/bale-workspace/chats/${chatId}/stars`, { body: { stars: next } }); onChange(r.stars); toast(r.stars ? `${fd(r.stars)} ستاره ثبت شد` : 'ستاره برداشته شد'); }
    catch (e) { toast(e instanceof BbError ? e.message : 'ستاره ثبت نشد.'); } finally { setBusy(false); }
  };
  return <span className="bws-starpick" role="radiogroup" aria-label="ستاره‌ی مشتری" data-testid="bws-starpick">
    {[1, 2, 3].map((i) => <button key={i} type="button" role="radio" aria-checked={value === i} aria-label={`${fd(i)} ستاره`} disabled={busy || disabled} onClick={() => set(i)}><Star on={i <= value} /></button>)}
  </span>;
}
