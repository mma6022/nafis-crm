import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`/api${path}`, { credentials: 'include', ...init, headers: { 'content-type': 'application/json', ...(init?.headers || {}) } });
  const body = await r.json().catch(() => null);
  if (!r.ok) throw Object.assign(new Error((body as { message?: string; error?: string } | null)?.message || (body as { error?: string } | null)?.error || `HTTP ${r.status}`), { status: r.status, body });
  return body as T;
}

export type AttMe = { enabled: boolean; flag: string; isAdmin: boolean; canManage: boolean };

export type AttSettings = {
  host: string; port: number; hasCommKey: boolean;
  deviceSn: string | null; deviceName: string | null;
  shiftStart: string; shiftEnd: string; graceMinutes: number; weeklyOff: number[];
  lastSyncAt: string | null; lastError: string | null; lastOkAt: string | null;
  configured: boolean; defaultsArePlaceholders: true; placeholderNote: string;
  reachabilityWarning: string | null;
};

export type AttStaff = { id: number; name: string; username: string; role: string; suggestedDeviceUserId: string | null };
export type AttMap = { deviceUserId: string; deviceUserName: string | null; crmUserId: number };
export type AttTest = {
  ok: boolean; error: string | null;
  info: { firmware: string | null; serial: string | null; deviceName: string | null } | null;
  users: { userId: string; name: string }[]; punchCount: number;
  reachabilityWarning: string | null;
};
export type BoardPerson = {
  crmUserId: number; name: string; deviceUserId: string | null;
  status: 'present' | 'left' | 'not_yet' | 'absent' | 'off' | 'unmapped';
  statusLabel: string; firstInClock: string | null; lastOutClock: string | null; late: boolean;
};
export type AttBoard = {
  date: string; jalaliLabel: string; timezone: 'Asia/Tehran';
  shiftStart: string; shiftEnd: string; graceMinutes: number;
  defaultsArePlaceholders: true; placeholderNote: string;
  lastSyncAt: string | null; lastError: string | null; people: BoardPerson[];
};
export type MonthDay = { date: string; jalaliDay: number; off: boolean; firstInClock: string | null; lastOutClock: string | null; workMinutes: number | null; late: boolean; absent: boolean };
export type MonthPerson = { crmUserId: number; name: string; deviceUserId: string | null; workMinutes: number; workHoursLabel: string; lateDays: number; absentDays: number; days: MonthDay[] };
export type AttReport = {
  jalaliYear: number; jalaliMonth: number; jalaliMonthLabel: string; timezone: 'Asia/Tehran';
  shiftStart: string; shiftEnd: string; graceMinutes: number;
  defaultsArePlaceholders: true; placeholderNote: string; noSalaryComputed: true;
  lastSyncAt: string | null; lastError: string | null; people: MonthPerson[];
};

export function useAttendanceMe(enabled: boolean) {
  return useQuery({
    queryKey: ['attendance-me'],
    enabled,
    queryFn: () => req<AttMe>('/attendance/me'),
    retry: false,
    staleTime: 30_000,
  });
}

export function useAttendanceSettings(enabled: boolean) {
  return useQuery({
    queryKey: ['attendance-settings'],
    enabled,
    queryFn: () => req<AttSettings>('/attendance/settings'),
    retry: (n, e) => (e as { status?: number })?.status !== 404 && (e as { status?: number })?.status !== 403 && n < 2,
  });
}

export function useAttendanceBoard(enabled: boolean, date?: string) {
  const q = date ? `?date=${encodeURIComponent(date)}` : '';
  return useQuery({
    queryKey: ['attendance-board', date || 'today'],
    enabled,
    queryFn: () => req<AttBoard>(`/attendance/board${q}`),
    retry: false,
  });
}

export function useAttendanceReport(enabled: boolean, year?: number, month?: number) {
  const p = new URLSearchParams();
  if (year) p.set('year', String(year));
  if (month) p.set('month', String(month));
  const s = p.toString();
  return useQuery({
    queryKey: ['attendance-report', year, month],
    enabled,
    queryFn: () => req<AttReport>(`/attendance/report${s ? `?${s}` : ''}`),
    retry: false,
  });
}

export function useAttendanceMutations() {
  const qc = useQueryClient();
  const invalidate = () => { void qc.invalidateQueries({ queryKey: ['attendance-settings'] }); void qc.invalidateQueries({ queryKey: ['attendance-board'] }); void qc.invalidateQueries({ queryKey: ['attendance-report'] }); };
  return {
    saveSettings: useMutation({
      mutationFn: (body: Record<string, unknown>) => req<AttSettings>('/attendance/settings', { method: 'PUT', body: JSON.stringify(body) }),
      onSuccess: invalidate,
    }),
    test: useMutation({
      mutationFn: (body: Record<string, unknown>) => req<AttTest>('/attendance/test', { method: 'POST', body: JSON.stringify(body) }),
    }),
    pull: useMutation({
      mutationFn: () => req<{ ok: boolean; error: string | null; inserted: number; total: number }>('/attendance/pull', { method: 'POST', body: '{}' }),
      onSuccess: invalidate,
    }),
    staffPreview: useMutation({
      mutationFn: (deviceUsers: { userId: string; name: string }[]) => req<{ staff: AttStaff[]; map: AttMap[] }>('/attendance/staff', { method: 'POST', body: JSON.stringify({ deviceUsers }) }),
    }),
    saveMap: useMutation({
      mutationFn: (entries: { deviceUserId: string; deviceUserName?: string | null; crmUserId: number | null }[]) =>
        req<{ staff: AttStaff[]; map: AttMap[] }>('/attendance/map', { method: 'PUT', body: JSON.stringify({ entries }) }),
      onSuccess: invalidate,
    }),
  };
}
