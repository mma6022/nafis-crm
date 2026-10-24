import { useQuery } from '@tanstack/react-query';
import { transcribeErrorMessage, uploadType } from './voice-note-text';

/** crm-voice-notes client. The server decides whether the feature is on for this user (flag + role). */
export type VoiceNotesConfig = { enabled: boolean; maxSeconds?: number; dailyLimitSeconds?: number; remainingSeconds?: number };
export type VoiceField = 'call_note' | 'first_call_note' | 'customer_description';
export type VoiceUsageRow = { userId: number; name: string | null; role: string; count: number; okCount: number; errorCount: number; seconds: number; minutes: number; estCostUsd: number };
export type VoiceUsage = {
  month: string; months: string[]; users: VoiceUsageRow[];
  providers?: { provider: string; model: string; served: number; fallbacks: number; minutes: number }[];
  totals: { count: number; errorCount: number; seconds: number; minutes: number; estCostUsd: number };
  config: { enabled: boolean; provider: string; model: string; hasKey: boolean; dailyLimitMinutes: number; pricePerMinuteUsd: number | null };
};
export class VoiceNoteApiError extends Error { constructor(message: string, public status: number) { super(message); } }

const base = () => (import.meta.env.BASE_URL || '/').replace(/\/$/, '');
export const VOICE_CONFIG_KEY = ['voice-notes-config'] as const;

export function useVoiceNotesConfig() {
  return useQuery({
    queryKey: VOICE_CONFIG_KEY, staleTime: 60_000, retry: false,
    queryFn: async (): Promise<VoiceNotesConfig> => {
      const r = await fetch(`${base()}/api/voice-notes/config`, { credentials: 'include' });
      if (!r.ok) return { enabled: false };
      return (await r.json()) as VoiceNotesConfig;
    },
  });
}

export async function transcribeVoiceNote(blob: Blob, seconds: number, field: VoiceField): Promise<{ text: string; seconds: number }> {
  let response: Response;
  try {
    response = await fetch(`${base()}/api/voice-notes/transcribe?field=${field}&duration=${Math.max(0.1, Math.round(seconds * 10) / 10)}`, {
      method: 'POST', credentials: 'include', headers: { 'Content-Type': uploadType(blob.type) }, body: blob,
    });
  } catch { throw new VoiceNoteApiError(transcribeErrorMessage(0, null), 0); }
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new VoiceNoteApiError(transcribeErrorMessage(response.status, body?.error), response.status);
  return body as { text: string; seconds: number };
}

export function useVoiceUsage(month: string | null) {
  return useQuery({
    queryKey: ['voice-notes-usage', month ?? 'current'], staleTime: 30_000,
    queryFn: async (): Promise<VoiceUsage> => {
      const r = await fetch(`${base()}/api/voice-notes/usage${month ? `?month=${month}` : ''}`, { credentials: 'include' });
      if (!r.ok) throw new VoiceNoteApiError('', r.status);
      return (await r.json()) as VoiceUsage;
    },
  });
}
