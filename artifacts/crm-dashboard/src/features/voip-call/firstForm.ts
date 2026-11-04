/** FIRSTFORM-VOIP (Mohammad t831u «وقتی برای تماس اول از ویپ استفاده میشه اتوماتیک فرم تماس اول باز نمیشه», rule t765u).
 *  The old path (tap the number / «تماس گرفتم») opens the first-call form as the call starts. A VoIP first call now does the same: the form
 *  opens by itself as soon as the expert has picked up the VoIP phone and the customer is being dialed / talking (not during the 30 s ring,
 *  so the «جواب بده» panel stays in view), and again after the hang-up if Simotel says «جواب داد» and the form is not saved yet (first_form).
 *  Who gets it is unchanged: SIMOTEL-132 on → the server's own first-call decision (s132.firstCall); off → the same rule as «ثبت تماس»
 *  (`simple` = useCallLauncher 'simple'). Non-first calls: nothing here runs. */
import { useEffect, useRef } from 'react';
import { useVcMe } from './api';

const TALK = new Set(['dial_cust', 'in_call']);
/** open(callId): callId = the VoIP call (required SIMOTEL-132 form) or null (flag off → the plain first-call form, as on the old path). */
export function useVoipFirstFormOpen(customerId: number | null | undefined, simple: boolean, open: (callId: number | null) => void, enabled = true) {
  const me = useVcMe().data;
  const c = me?.on && me.call && customerId != null && me.call.customerId === customerId ? me.call : null;
  const sc = c?.s132 ?? null;
  const stage = !c ? null : sc ? (sc.phase === 'first_form' ? 'form' : sc.phase === 'live' && sc.firstCall && c.active && TALK.has(c.state) ? 'talk' : null)
    : me?.s132 ? null : simple && c.active && TALK.has(c.state) ? 'talk' : null;
  const shown = useRef<Set<string>>(new Set());
  const openRef = useRef(open); openRef.current = open;
  useEffect(() => {
    if (!enabled || !c || !stage) return;
    const k = `${c.id}:${stage}`; if (shown.current.has(k)) return;
    const id = c.id; const voip = Boolean(sc);
    // a mandatory reminder popup already open stays on top: the form opens by itself once it is gone
    const tryOpen = () => { if (shown.current.has(k) || document.querySelector('.rmm-root [data-testid=rm-overlay]')) return; shown.current.add(k); openRef.current(voip ? id : null); };
    tryOpen(); const iv = window.setInterval(tryOpen, 1500); return () => window.clearInterval(iv);
  }, [enabled, c?.id, stage]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** A required (voip) first-call form that was opened during the call and is still unsaved is closed again (its draft stays in the browser)
 *  when the call no longer needs it: Simotel saved it as «جواب نداد/اشغال/ناموفق» (the first call stays for the next call, unchanged), the
 *  result did not arrive in time (the four status buttons must be reachable; «جواب داد» reopens the form), or the form was saved elsewhere. */
export function useVoipFormRelease(voip: { callId: number } | null, saved: boolean, release: () => void) {
  const me = useVcMe().data;
  const c = me?.call ?? null;
  const ph = voip && c && c.id === voip.callId ? (c.s132?.phase ?? null) : null;
  const gone = Boolean(voip && !saved && me?.on && (ph == null || !(ph === 'live' || ph === 'waiting' || ph === 'first_form')));
  const relRef = useRef(release); relRef.current = release;
  useEffect(() => { if (gone) relRef.current(); }, [gone]);
}
