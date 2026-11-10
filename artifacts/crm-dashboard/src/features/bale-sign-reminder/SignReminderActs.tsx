/** bale-sign-reminder v1.0 — CRM actions, confirm modal, banners. Pixel-for-pixel from Armita's handoff CSS.
 *  Hidden entirely while flag.bale_sign_reminder is OFF (server omits chat.signReminder). */
import { useState } from 'react';
import { Link } from 'wouter';
import { bbFetch, BbError, type BbChat, type SrView } from '../bale-bot/api';
import { I, Cid, Ph } from '../bale-bot/ui';
import './bale-sign-reminder.css';

function signStatusFa(state: SrView['state'], fallback?: string | null) {
  if (state === 'already_signed') return 'امضا شد';
  if (state === 'link_expired') return 'لینک امضا منقضی شده';
  return fallback || 'در انتظار امضا';
}

export function SignReminderActs({
  chat, where, toast, refresh, err, onRefreshStatus,
}: {
  chat: BbChat;
  where: 'meta' | 'pane';
  toast: (t: string) => void;
  refresh?: () => void;
  err?: (e: unknown) => void;
  onRefreshStatus: () => void;
}) {
  void err;

  const sr = chat.signReminder;
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<'confirm' | 'sending' | 'error'>('confirm');
  const [serverErr, setServerErr] = useState<string | null>(null);
  if (!sr?.enabled) return null;

  const hideBtn = sr.state === 'already_signed' || sr.state === 'link_expired' || sr.state === 'no_contract' || (sr.state === 'no_token' && !sr.canOpenKeyCard) || (sr.otherExpert && !sr.canSend && sr.state !== 'cooldown' && sr.state !== 'no_token');
  const otherLocked = sr.otherExpert && !sr.canSend;
  const disabled = sr.state === 'bot_not_started' || sr.state === 'cooldown' || !sr.canSend;
  const cool = sr.state === 'cooldown' || (sr.state === 'ready' && sr.lockUntilFa && !sr.canSend);

  const reminderBtn = () => {
    if (hideBtn && !otherLocked) return null;
    if (otherLocked && sr.state !== 'cooldown') return null;
    if (sr.state === 'bot_not_started' || sr.state === 'no_token') {
      return <button className="btn pri sm" type="button" aria-disabled="true" tabIndex={-1} data-testid="sr-remind">یادآوری امضا در بله</button>;
    }
    if (sr.state === 'cooldown' || cool) {
      return <button className="btn pri sm sr-cool" type="button" aria-disabled="true" tabIndex={-1} data-testid="sr-remind">یادآوری فرستاده شد؛ ارسال دوباره از {sr.lockUntilFa}</button>;
    }
    return <button className="btn pri sm" type="button" data-testid="sr-remind" onClick={() => { setPhase('confirm'); setServerErr(null); setOpen(true); }}>یادآوری امضا در بله</button>;
  };
  const refreshBtn = <button className="btn gh sm" type="button" data-testid="sr-refresh" onClick={onRefreshStatus}>به‌روزرسانی وضعیت</button>;

  const why = (() => {
    if (sr.state === 'no_token') {
      return <>
        <p className="sr-why">{sr.reason}</p>
        {sr.canOpenKeyCard ? <div className="sr-key-link"><Link className="btn gh sm" href="/bale-bot/admin?tab=keys" data-testid="sr-key-card">رفتن به کارت کلید</Link></div> : null}
      </>;
    }
    if (sr.state === 'bot_not_started') return <p className="sr-why">{sr.reason}</p>;
    if (sr.state === 'link_expired' || sr.state === 'already_signed') return <p className="sr-why">{sr.reason}</p>;
    if (otherLocked) {
      return <>
        {sr.lockUntilFa ? <p className="sr-why">یادآوری فرستاده شد؛ ارسال دوباره از {sr.lockUntilFa}</p> : null}
        <p className="bc-perm">ارسال یادآوری فقط با کارشناس مشتری یا ادمین{chat.expert?.name ? `. این گفتگو را ${chat.expert.name} می‌بیند.` : '.'}</p>
      </>;
    }
    return null;
  })();
  const lastLine = (sr.lastSentFa && (sr.state === 'cooldown' || otherLocked))
    ? <p className="sr-last">آخرین ارسال: <b>{sr.lastSentFa}</b></p>
    : null;

  const send = async () => {
    setPhase('sending'); setServerErr(null);
    try {
      const r = await bbFetch<{ ok: true; lastSentFa: string; lockUntilFa: string }>(`/bale-bot/chats/${chat.id}/sign-reminder`, { body: {} });
      setOpen(false); setPhase('confirm');
      toast('فرستاده شد');
      refresh?.();
      void r;
    } catch (e) {
      setPhase('error');
      setServerErr(e instanceof BbError ? e.message : 'ارتباط با بله برقرار نشد. دوباره تلاش کنید.');
      /* Error stays in the modal; do not toast it over retry/cancel or «امضای قرارداد». */
    }
  };

  const modal = open ? <div className="sr-modal" role="presentation" data-testid="sr-modal" data-nodnd>
    <div className="sr-dialog" role="dialog" aria-modal="true" aria-labelledby="sr-ttl" data-nodnd>
      <h3 id="sr-ttl">ارسال یادآوری امضا در بله</h3>
      <div className="sr-who">
        <span className="nm">{chat.customer?.name ?? chat.name}</span>
        {chat.customer ? <Cid id={chat.customer.id} toast={toast} /> : null}
      </div>
      {chat.customer?.phone ? <Ph phone={chat.customer.phone} toast={toast} /> : null}
      <p className="sr-note">این همان متنی است که در بله فرستاده می‌شود. <span className="nw">پیامک فرستاده نمی‌شود.</span></p>
      <p className="sr-note">متن قرارداد عوض نمی‌شود. لینک امضا همان لینک مسیر صدور فعلی است.</p>
      {phase === 'sending' ? <div className="sr-banner wait" role="status">{I({ n: 'clock' })}<div><b>در حال ارسال</b>یادآوری در بله فرستاده می‌شود.</div></div> : null}
      {phase === 'error' && serverErr ? <div className="sr-banner err" role="alert">{I({ n: 'alert' })}<div><b>ارسال انجام نشد</b>پیام سرور: {serverErr}</div></div> : null}
      <div className="sr-prev">
        <span className="plab">متن پیام در بله</span>
        <div className="bc-msg in">
          <div className="bc-bub">{sr.messageText}</div>
          <div className="bc-ikb sr-ikb"><span className="bc-ik sr-ik">{sr.buttonLabel}</span></div>
        </div>
      </div>
      <div className="sr-acts-dlg">
        {phase === 'sending'
          ? <button className="btn pri sm" type="button" aria-disabled="true" tabIndex={-1}>در حال ارسال</button>
          : phase === 'error'
            ? <button className="btn pri sm" type="button" onClick={() => void send()}>تلاش دوباره</button>
            : <button className="btn pri sm" type="button" onClick={() => void send()} disabled={disabled && sr.state !== 'ready'}>ارسال یادآوری</button>}
        {phase === 'sending'
          ? <button className="btn gh sm" type="button" aria-disabled="true" tabIndex={-1}>انصراف</button>
          : <button className="btn gh sm" type="button" onClick={() => { setOpen(false); setPhase('confirm'); setServerErr(null); }}>انصراف</button>}
      </div>
    </div>
  </div> : null;

  if (where === 'meta') {
    if (sr.state === 'no_contract' || sr.state === 'hidden') return null;
    return <>
      <div className="sr-acts" data-testid="sr-acts-meta">{reminderBtn()}{refreshBtn}</div>
      {lastLine}{why}
      {modal}
    </>;
  }
  return <>
    {lastLine}
    <div className="sr-acts" data-testid="sr-acts-pane">{reminderBtn()}{refreshBtn}</div>
    {why}
    {modal}
  </>;
}

export function SignReminderBanner({ chat }: { chat: BbChat }) {
  const sr = chat.signReminder;
  if (!sr?.enabled) return null;
  if (sr.state === 'cooldown' && sr.lastSentFa) {
    return <div className="sr-banner ok" role="status" data-testid="sr-banner-sent">{I({ n: 'check' })}<div><b>فرستاده شد</b>آخرین ارسال: {sr.lastSentFa}</div></div>;
  }
  return null;
}

export function SignReminderSys({ chat }: { chat: BbChat }) {
  const sr = chat.signReminder;
  if (!sr?.enabled) return null;
  if (sr.state === 'already_signed') return <div className="sys" role="status">وضعیت امضا: امضا شد</div>;
  if (sr.state === 'link_expired') return <div className="sys" role="status">وضعیت امضا: لینک امضا منقضی شده</div>;
  if (sr.state === 'bot_not_started') return <div className="sys" role="status">این مشتری ربات را شروع نکرده است.</div>;
  if (sr.state === 'cooldown' || (sr.lastSentFa && sr.otherExpert)) return <div className="sys" role="status">یادآوری امضا در بله فرستاده شد.</div>;
  return null;
}

export function signStatusLabel(chat: BbChat, fallback?: string | null) {
  return chat.signReminder?.enabled ? signStatusFa(chat.signReminder.state, fallback) : (fallback ?? null);
}
