/**
 * «درخواست تماس کارشناس»: operational settings in one place. Values are config, not code paths, so the
 * office can change them without touching the rules. Env overrides exist for the numbers only.
 *
 * - Working hours 09:00–18:00 Asia/Tehran, Saturday–Wednesday (days still awaiting confirmation; mirrors
 *   the site's lib/site WORK_HOURS). Morning = 09–13, evening = 13–18.
 * - SLA is internal only: a «همین الان» request still «جدید» after slaMinutes is shown as late in the CRM.
 *   The customer is never promised a number of minutes.
 * - «پاسخ نداد» is capped at maxAttempts with at least minAttemptGapMinutes between attempts. After the cap
 *   the CRM suggests «لغو»; nothing is cancelled automatically.
 */
function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw || !/^\d{1,5}$/.test(raw)) return fallback;
  const n = Number(raw);
  return n >= min && n <= max ? n : fallback;
}

export const CALLBACK_CONFIG = {
  timeZone: "Asia/Tehran",
  workStartHour: 9,
  workEndHour: 18,
  /** 0 = Sunday … 6 = Saturday. Sat, Sun, Mon, Tue, Wed. */
  workDays: [6, 0, 1, 2, 3] as readonly number[],
  morning: { start: 9, end: 13 },
  evening: { start: 13, end: 18 },
  slaMinutes: envInt("CALLBACK_SLA_MINUTES", 15, 1, 1440),
  maxAttempts: envInt("CALLBACK_MAX_ATTEMPTS", 3, 1, 20),
  minAttemptGapMinutes: envInt("CALLBACK_MIN_ATTEMPT_GAP_MINUTES", 60, 0, 1440),
} as const;

const WD: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Hour (0–23) and weekday (0 = Sunday) in Asia/Tehran, independent of the server's zone. */
export function tehranClock(at: Date): { hour: number; weekday: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: CALLBACK_CONFIG.timeZone, hour: "numeric", hourCycle: "h23", weekday: "short",
  }).formatToParts(at);
  return {
    hour: Number(parts.find((p) => p.type === "hour")?.value ?? 0) % 24,
    weekday: WD[parts.find((p) => p.type === "weekday")?.value ?? "Sun"] ?? 0,
  };
}

export function isWorkingHours(at: Date): boolean {
  const { hour, weekday } = tehranClock(at);
  return CALLBACK_CONFIG.workDays.includes(weekday) && hour >= CALLBACK_CONFIG.workStartHour && hour < CALLBACK_CONFIG.workEndHour;
}
