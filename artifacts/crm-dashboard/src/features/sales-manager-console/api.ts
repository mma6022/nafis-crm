// «مدیریت تیم فروش» v1.1 — client for /api/sales-admin/* (flag.sales_manager_console_v1; OFF → 404 → page and nav item hidden).
import { useQuery } from '@tanstack/react-query';

export type SectionId = 'teams' | 'daily' | 'access' | 'valid' | 'model' | 'dist' | 'steps';
export const SECTION_IDS: SectionId[] = ['teams', 'daily', 'access', 'valid', 'model', 'dist', 'steps'];
export type Block = { from: number; to: number; k: 'actual' | 'potential' | 'any' };
export type Expert = { id: string; displayName: string; extension: string | null; role: 'expert' | 'lead'; status: 'active' | 'leave' | 'inactive'; leaveUntil: string | null; userId: number | null; salespersonId: number | null; teamId: string | null };
export type Team = { id: string; name: string; leadExpertId: string | null; deleted?: boolean };
export type Move = { expertId: string; from: string | null; to: string; keepCustomers: boolean };
export type TeamsDoc = { teams: Team[]; experts: Expert[]; moves?: Move[] };
export type DailyOp = { op: 'add' | 'remove' | 'move' | 'restore'; expertId: string; date: string; customerId: number; blockIdx?: number; sort?: number; atTime?: string | null; toDate?: string | null; ref?: number };
export type DailyDoc = { blocks: { global: Block[] | null; team: Record<string, Block[]>; expert: Record<string, Block[]> }; ops?: DailyOp[] };
export type Level = 'locked' | 'own' | 'team' | 'all';
export type AccessDoc = { policies: Record<string, { customers: Level; loan_files: Level }> };
export type Validity = { mode: 'forever' | 'hours'; hours: number };
export type ValidDoc = { identity: Validity; credit: Validity; appliedAt?: { identity: string | null; credit: string | null } };
export type Rule = { id: string; subject: string; op: string; value: unknown; outcome: string; outcomeValue?: unknown };
export type Mix = { followup: number; lead: number; actual: number; cold: number };
export type Model = { id: string; name: string; capacity: number; mix: Mix; rules: Rule[]; weights: Record<string, number>; retryHours: number; useTeamBlocks: boolean; assign: { scope: 'expert' | 'team'; id: string }[] };
export type ModelDoc = { models: Model[] };
export type Cond = { field: string; values: string[] };
export type Method = { method: 'direct' | 'ratio' | 'percent' | 'round_robin' | 'capacity'; targets: { id: string; weight?: number }[] };
export type DistRule = { id: string; conds: Cond[] } & Method;
export type DistDoc = { team: { rules: DistRule[]; fallback: Method }; member: Record<string, { rules: DistRule[]; fallback: Method }>; caps: Record<string, { percent: number; dailyCap: number }> };
export type Stage = { key: string; label: string; phase: number; turn: 'us' | 'customer'; enabled: boolean; optional: boolean; docs: string[]; custom?: boolean };
export type StepsDoc = { plans: Record<string, Stage[] | null> };
export type Docs = { teams: TeamsDoc; daily: DailyDoc; access: AccessDoc; valid: ValidDoc; model: ModelDoc; dist: DistDoc; steps: StepsDoc };
export type Meta = { version: number; updatedBy: number | null; updatedAt: string | null; updatedByName: string | null };
export type Draft = { doc: unknown; baseVersion: number; changes: number; updatedAt: string };
export type Person = Expert & { customers: number; openFiles: number; rulesNaming: number; hasModel: string | null };
export type SmcState = {
  dateFa: string; today: string; sums: Record<SectionId | 'audit', string>; meta: Record<SectionId, Meta>; drafts: Partial<Record<SectionId, Draft>>;
  docs: Docs; people: Person[]; users: { id: number; name: string; role: string; salespersonId: number | null }[]; plans: { key: string; name: string }[];
  systemStages: Stage[]; stageGroups: { contract: string[]; guarantor: string[]; collateral: string[] };
  stale: { level: 'team' | 'member'; teamId: string | null; index: number; text: string }[]; defaultWeights: Record<string, number>; levelsFa: Record<Level, string>;
};
export type QRow = { key: string; customerId: number | null; name: string; type: string; why: string; source: 'urgent' | 'system' | 'manual' | 'moved' | 'removed'; blockIdx: number; locked: boolean; overrideId: number | null; overCapacity?: boolean; score?: number; draft?: boolean };
export type Queue = { expertId: string; date: string; dateFa: string; blocks: (Block & { label: string; kindFa: string })[]; blockScope: string; model: { id: string; name: string; capacity: number } | null; rows: QRow[]; count: number; manual: number; removed: number; noAccount: boolean };
export type Preview = { expert: string; date: string; dateFa: string; counts: { fu: number; lead: number; file: number; cold: number }; diff: { added: number; out: number; moved: number; manualKept: number }; top: { type: string; name: string; why: string }[]; more: number; total: number };
export type RouteResult = { teamId: string | null; expertId: string | null; teamRule: number | null; memberRule: number | null; path: { level: 1 | 2 | 3; text: string }[]; unassigned: boolean };
export type AuditRow = { id: number; at: string; atFa: string; who: string; section: string; sectionFa: string; summary: string; revertOf: number | null };
export type ApiError = Error & { status?: number; body?: { error?: string; message?: string; errors?: { section: string; field: string; message: string }[]; conflict?: { section: string; by: string | null; atFa: string | null } } };

export async function smcApi<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const r = await fetch(`/api/sales-admin${path}`, {
    method: init?.method ?? 'GET', credentials: 'include',
    headers: init?.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  if (!r.ok) {
    const body = await r.json().catch(() => null);
    throw Object.assign(new Error(body?.message ?? `HTTP ${r.status}`), { status: r.status, body }) as ApiError;
  }
  return (await r.json()) as T;
}

/** Nav gate: 404 (flag OFF) and 403 (not a manager) both mean «no item». Never retried. `merged` only while flag.sales_admin_merge_v12 is ON. */
export type SmcMe = { enabled: boolean; canManage: boolean; roleLabel: string; merged?: boolean; path?: string; accessRoles?: string[] };
export function useSmcMe(enabled: boolean) {
  return useQuery({ queryKey: ['smc-me'], enabled, retry: false, staleTime: 60_000, queryFn: () => smcApi<SmcMe>('/me') });
}

/* ---------------- v1.2 «مدیریت فروش» merge (flag.sales_admin_merge_v12) ---------------- */
export type LiveMember = { salespersonId: number; name: string; isLead: boolean; ownsNone: boolean; ownsP1: boolean; ownsP2: boolean; ownsP3: boolean; sortOrder: number };
export type LiveTeam = { id: number; name: string; enabled: boolean; leadSplitQuota: number; members: LiveMember[] };
export type MergeState = {
  importedAt: string | null; importedAtFa: string | null; parity: { imported: boolean; ok: boolean; diffs: string[]; importedAt: string | null };
  values: {
    teams: LiveTeam[]; intake: { source: 'new_customers' | 'site_leads'; teamId: number; percent: number }[]; intakeSplit: { source: string; teamIds: number[] }[];
    defaultOwner: { enabled: boolean; ownerSalespersonId: number | null; registrarMode: 'all' | 'selected'; registrarUserIds: number[]; registrarNames: string[]; sourceMode: 'all' | 'selected'; sources: string[] };
    defaultSourceBySeller: Record<string, string>;
    queue: { order: string[]; newRedHours: number; p1StaleDays: number; naTemplate: string };
    daily: { guardPct: number; waitMin: number; firstDayCapacity: number | null };
    discipline: { onTimeMin: number; onTimeCapMin: number; newPct: number; newMaxOverdue: number; restrictOverdue: number; alertDays: number; wReport: number; wOverdue: number; wNocall: number; dropPct: number; transferMode: 'warn' | 'block'; excludedReceivers: number[] };
    assist: { settings: { levels: Record<string, number>; snoozeHours?: number }; p1: { quota: number; redDays: number; noCallDays: number } };
  };
  labels: { queueGroups: Record<string, string>; regSources: Record<string, string>; leadSources: Record<string, string>; signals: Record<string, string>; sellers: Record<string, string>; receivers: Record<string, string> };
  conversion: { applicable: boolean; reason: string; teamRule: unknown; memberRule: { teamId: string; rule: { targets: { id: string }[] } } | null; blockers: string[]; writes: { table: string; key: string; note: string }[] };
  writable: { teamName: boolean; teamEnabled: boolean; other: boolean };
};
export function useMergeState(enabled: boolean) {
  return useQuery({ queryKey: ['smc-merge'], enabled, retry: false, staleTime: 0, refetchOnWindowFocus: false, queryFn: () => smcApi<MergeState>('/merge/state') });
}
export function useSmcState() {
  return useQuery({ queryKey: ['smc-state'], retry: false, staleTime: 0, refetchOnWindowFocus: false, queryFn: () => smcApi<SmcState>('/state') });
}
export const smcPath = '/sales-team-admin';
export const samPath = '/sales-admin';
