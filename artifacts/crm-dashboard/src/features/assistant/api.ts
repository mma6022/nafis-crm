/** «دستیار هوشمند» staff client (api-server lib/assistants.ts). The server is the real gate for scope. */
/** 'manager' = «احمد | مدیر فروش» (admin only, read-only reports). */
export type AsKind = 'sales' | 'filing' | 'manager';
export type AsPrefs = { sound: boolean; dndUntil: string | null; dnd: boolean; quiet: boolean };
export type AsMine = { id: number; slug: string; name: string; label: string; kind: AsKind; threadId: number; unread: number; typing: boolean; online: boolean };
export type AsMessage = {
  id: number; threadId: number; author: 'user' | 'assistant' | 'system'; authorLabel: string | null; kind: string; priority: 'low' | 'normal' | 'high';
  body: string; customerId: number | null; customerName: string | null; clientId: string | null; createdAt: string;
  pickedAt: string | null; deliveredAt: string | null; readAt: string | null; actedAt: string | null; actionTaken: string | null; suppressed: string | null;
  proposal?: AsProposal | null;
};
export type AsProposal = { id: number; customerId: number; remindAt: string; note: string | null; status: 'pending' | 'accepted' | 'rejected' | 'expired'; reminderId: number | null; decidedAt: string | null };
export type AsThread = { messages: AsMessage[]; userSeen: { id: number; seen: boolean }[]; typing: boolean; online: boolean; prefs: AsPrefs };
export type AsAction = 'call' | 'remind' | 'copy' | 'later';

const base = () => (import.meta.env.BASE_URL || '/').replace(/\/$/, '');
export class AsError extends Error { constructor(message: string, public status: number, public code?: string) { super(message); } }
export async function asFetch<T>(path: string, init?: { method?: string; body?: unknown; signal?: AbortSignal }): Promise<T> {
  const r = await fetch(`${base()}/api${path}`, {
    method: init?.method ?? 'GET', credentials: 'include', signal: init?.signal,
    headers: init?.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new AsError((data as any).message || ERR[(data as any).error] || 'درخواست انجام نشد. دوباره تلاش کنید.', r.status, (data as any).error);
  return data as T;
}
const ERR: Record<string, string> = { forbidden: 'دسترسی ندارید.', not_found: 'پیدا نشد.', bad_body: 'متن پیام خالی یا خیلی بلند است.', bad_limit: 'عدد بین ۱ تا ۳۰ باشد.' };

export const AS_COLORS: Record<string, string> = { masoud: '#29369B', somayeh: '#1F7A4D', mohaddeseh: '#8A6212', sarina: '#00006D', ahmad: '#5E2B97' };
export const asColor = (slug: string) => AS_COLORS[slug] ?? '#29369B';
export const faNum = (n: number | string) => String(n).replace(/\d/g, d => '۰۱۲۳۴۵۶۷۸۹'[Number(d)]);
export const asTime = (iso: string | null) => iso ? new Date(iso).toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Tehran' }) : '';
export const asWhen = (iso: string | null) => iso ? new Date(iso).toLocaleString('fa-IR-u-ca-persian', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Tehran' }) : '—';
/** Who may see the assistant UI at all (mirrors the server; trainees 5/19/20 and user 29 never). */
export const AS_TRAINEES: readonly number[] = [5, 19, 20];
export function asVisibleTo(user: { id?: number; role?: string | null; salespersonId?: number | null } | null | undefined) {
  if (!user || user.id === 29) return false;
  if (user.role === 'salesperson') return Boolean(user.salespersonId && !AS_TRAINEES.includes(user.salespersonId));
  return user.role === 'admin' || user.role === 'registrar';
}

/** Soft two-note chime via WebAudio (no audio files). Browsers need one user gesture first; we unlock on the first pointerdown. */
let ctx: AudioContext | null = null;
export function unlockAudio() {
  try { const C = window.AudioContext || (window as any).webkitAudioContext; if (!C) return; ctx = ctx ?? new C(); if (ctx.state === 'suspended') void ctx.resume(); } catch { /* ignore */ }
}
let lastChime = 0;
export function chime(high = false) {
  try {
    if (!ctx || ctx.state !== 'running' || document.hidden) return;
    if (Date.now() - lastChime < 60_000) return; // at most one sound per minute
    lastChime = Date.now();
    const t = ctx.currentTime; const notes = high ? [784, 988, 1175] : [660, 880];
    notes.forEach((f, i) => {
      const o = ctx!.createOscillator(); const g = ctx!.createGain(); o.type = 'sine'; o.frequency.value = f;
      const s = t + i * 0.12; g.gain.setValueAtTime(0, s); g.gain.linearRampToValueAtTime(0.06, s + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, s + 0.35);
      o.connect(g).connect(ctx!.destination); o.start(s); o.stop(s + 0.4);
    });
  } catch { /* ignore */ }
}
