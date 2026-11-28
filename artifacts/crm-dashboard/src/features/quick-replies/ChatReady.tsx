/* t979 v1.1 — the same panel outside the tray: the customer file's Bale tab (FileReady) and the inbox when the workspace flag is OFF (QrBar).
   Data: the workspace context of that chat when «فضای کار بله» is on (current plan, plans explained in the chat), otherwise /bale-bot/quick. */
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { bbFetch, type BbChat, type BbMe } from '@/features/bale-bot/api';
import { I } from '@/features/bale-bot/ui';
import { useChatCtx } from '@/features/bale-workspace/api';
import { ReadyTray } from './ReadyTray';
import type { QrReady } from './api';

const BLOCKED = 'ارسال در این گفتگو الان ممکن نیست.';
function useChatReady(chat: Pick<BbChat, 'id'>, workspace: boolean) {
  const qc = useQueryClient();
  const ctxQ = useChatCtx(chat.id, workspace);
  const quickQ = useQuery<{ ready?: QrReady } | null>({ queryKey: ['bb-quick'], retry: false, staleTime: 60_000, refetchOnWindowFocus: false, queryFn: () => bbFetch<{ ready?: QrReady }>('/bale-bot/quick').catch(() => null) });
  const a = ctxQ.data?.assets; const c = ctxQ.data?.context && !ctxQ.data.context.restricted ? ctxQ.data.context : null;
  const ready = (workspace ? a?.ready : null) ?? quickQ.data?.ready ?? null;
  const reload = () => { void qc.invalidateQueries({ queryKey: ['bws-ctx', chat.id] }); void qc.invalidateQueries({ queryKey: ['bb-quick'] }); void qc.invalidateQueries({ queryKey: ['bb-cust'] }); };
  return { ready: ready?.v11 ? ready : null, explained: c?.explained.map((e) => e.planId) ?? [], customer: c?.customer.name ?? null, reload };
}

/** Customer file → «بله»: a «پیام‌های آماده» button beside «باز کردن گفتگو»; it opens the same tray (three tabs, «ارسال» exactly like in the chat) as a side sheet,
 *  so the conversation list keeps the full width of the card. Esc, «×» or a tap on the dimmed page closes it. */
export function FileReadyButton({ chat, me }: { chat: BbChat; me: BbMe }) {
  const d = useChatReady(chat, !!me.workspace);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape' && !document.querySelector('[data-testid=qr-preview]')) setOpen(false); };
    document.addEventListener('keydown', k); return () => document.removeEventListener('keydown', k);
  }, [open]);
  if (!d.ready) return null;
  const canSend = chat.canWrite && !chat.sendBlocked;
  return <>
    <button type="button" className="btn gh sm qr-fopen" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen(true)} data-testid="qr-file-open"><I n="note" />پیام‌های آماده</button>
    {open ? createPortal(<div className="qr-fscrim" onMouseDown={(e) => { if (e.target === e.currentTarget) setOpen(false); }} data-testid="qr-file-scrim">
      <aside className="qr-fsheet" role="dialog" aria-label="پیام‌های آماده" dir="rtl" data-testid="qr-file-sheet">
        <ReadyTray surface="file" ready={d.ready} chatId={chat.id} canSend={canSend} blockedHint={canSend ? null : BLOCKED} customer={d.customer ?? chat.customer?.name ?? chat.name} expert={me.name} explained={d.explained}
          onChanged={d.reload} onSent={d.reload} onClose={() => setOpen(false)} />
      </aside>
    </div>, document.body) : null}
  </>;
}

/** Inbox without «فضای کار بله»: one button in the quick bar that opens the panel above the composer. */
export function QrBar({ chat, me, refresh }: { chat: BbChat; me: BbMe; refresh: () => void }) {
  const d = useChatReady(chat, false);
  const [open, setOpen] = useState(false);
  if (!d.ready) return null;
  const canSend = chat.canWrite && !chat.sendBlocked;
  return <>
    <div className="qbar" role="group" aria-label="پیام‌های آماده" data-testid="bb-quickbar"><button type="button" className="qb" aria-expanded={open} onClick={() => setOpen(!open)} data-testid="qr-open"><I n="note" />پیام‌های آماده</button></div>
    {open ? <div className="qr-tray-in" data-testid="qr-tray"><ReadyTray ready={d.ready} chatId={chat.id} canSend={canSend} blockedHint={canSend ? null : BLOCKED} customer={chat.customer?.name ?? chat.name} expert={me.name} explained={[]}
      onChanged={d.reload} onSent={() => { d.reload(); refresh(); }} onClose={() => setOpen(false)} /></div> : null}
  </>;
}
