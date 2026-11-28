/* t979 v1.1 — the same panel outside the tray: the customer file's Bale tab (FileReady) and the inbox when the workspace flag is OFF (QrBar).
   Data: the workspace context of that chat when «فضای کار بله» is on (current plan, plans explained in the chat), otherwise /bale-bot/quick. */
import { useState } from 'react';
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

/** Customer file → «بله»: the three-tab list beside the thread; «ارسال» behaves exactly like in the chat. */
export function FileReady({ chat, me }: { chat: BbChat; me: BbMe }) {
  const d = useChatReady(chat, !!me.workspace);
  if (!d.ready) return null;
  const canSend = chat.canWrite && !chat.sendBlocked;
  return <ReadyTray surface="file" ready={d.ready} chatId={chat.id} canSend={canSend} blockedHint={canSend ? null : BLOCKED} customer={d.customer ?? chat.customer?.name ?? chat.name} expert={me.name} explained={d.explained}
    onChanged={d.reload} onSent={d.reload} />;
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
