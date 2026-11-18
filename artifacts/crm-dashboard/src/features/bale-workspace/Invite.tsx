/* «فضای کار بله» ه‍ — دعوت به بله (بله + پیامک با هم). No Bale account → «این شماره بله ندارد» on screen, the SMS still goes (Mohammad t381s1476). */
import { useEffect, useRef, useState } from 'react';
import { bbFetch } from '@/features/bale-bot/api';
import { bwsErr, jDate, type BwsInvite } from './api';

const BALE_FA: Record<BwsInvite['bale'], string> = { queued: 'در صف ارسال بله…', sent: 'در بله فرستاده شد.', no_bale: 'این شماره بله ندارد', not_connected: 'حساب بله‌ی کارشناس وصل نیست؛ در بله فرستاده نشد.', blocked: 'بله الان اجازهٔ ارسال نداد (ساعت یا سقف ارسال).', failed: 'ارسال در بله انجام نشد.' };
const SMS_FA: Record<BwsInvite['sms'], string> = { sent: 'پیامک دعوت فرستاده شد.', failed: 'پیامک فرستاده نشد.', not_configured: 'پیامک دعوت: تنظیم نشده (کد الگو در «مدیریت فروش» ثبت نشده است).', disabled: 'پیامک در این محیط خاموش است.' };

export function InviteResult({ inv, compact = false }: { inv: BwsInvite; compact?: boolean }) {
  if (inv.line) return <p className="bws-res ok" role="status" data-testid="bws-invite-ok"><b>{inv.line}</b>{!compact ? <span>{jDate(inv.at)}</span> : null}</p>;
  return <div className={`bws-res${inv.error ? ' err' : ''}`} role={inv.error ? 'alert' : 'status'} data-testid={inv.error ? 'bws-invite-err' : 'bws-invite-state'}>
    {inv.error ? <b className="bws-err">{inv.error}</b> : <b>{BALE_FA[inv.bale]}</b>}
    <span>{SMS_FA[inv.sms]}{!compact ? ` · ${jDate(inv.at)}` : ''}</span>
  </div>;
}
/** One button + live result. `path` = /bale-workspace/chats/:id/invite or /bale-workspace/customers/:id/invite. */
export function InviteButton({ path, last, onDone, toast, label = 'دعوت به بله', cls = 'bws-btn' }: { path: string; last?: BwsInvite | null; onDone?: (i: BwsInvite) => void; toast: (t: string) => void; label?: string; cls?: string }) {
  const [busy, setBusy] = useState(false); const [inv, setInv] = useState<BwsInvite | null>(last ?? null);
  const timer = useRef<number | null>(null);
  useEffect(() => { setInv(last ?? null); }, [last?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);
  const poll = (id: number, left: number) => {
    timer.current = window.setTimeout(async () => {
      try { const r = await bbFetch<{ invite: BwsInvite }>(`/bale-workspace/invites/${id}`); setInv(r.invite); if (r.invite.bale === 'queued' && left > 0) poll(id, left - 1); else onDone?.(r.invite); } catch { /* keep last */ }
    }, 2000);
  };
  const go = async () => {
    setBusy(true);
    try { const r = await bbFetch<{ invite: BwsInvite }>(path, { body: {} }); setInv(r.invite); if (r.invite.bale === 'queued') poll(r.invite.id, 15); else onDone?.(r.invite); }
    catch (e) { toast(bwsErr(e)); } finally { setBusy(false); }
  };
  return <div className="bws-inv">
    <button className={cls} type="button" onClick={go} disabled={busy} aria-busy={busy} data-testid="bws-invite"><svg className="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12l16-7-6 16-3-6.5z" /></svg>{busy ? 'در حال ارسال…' : label}</button>
    {inv ? <InviteResult inv={inv} /> : null}
  </div>;
}
