/* «دسترسی این صفحه» v1 client (t942u). flag.page_access_v1 OFF → /me {enabled:false} and nothing else is called. */
import { useQuery } from "@tanstack/react-query";

const base = () => (import.meta.env.BASE_URL || "/").replace(/\/$/, "");
export type PaLevel = "view" | "manage";
export type PaGrantable = "never" | "view" | "both";
export type PaPageMeta = { key: string; label: string; routes: string[]; kind: "permission" | "admin" | "bespoke"; grantable: PaGrantable };
export type PaMe = {
  enabled: boolean; canManage?: boolean; error?: boolean; locked?: boolean;
  pages?: PaPageMeta[]; granted?: Record<string, PaLevel>; blocked?: string[]; basePermissions?: string[] | null;
};
export type PaRole = { slug: string; name: string; members: number; default: PaLevel | null; grant: { id: number; level: PaLevel } | null };
export type PaUserRow = {
  id: number; name: string; role: string; roleName: string; kind: "always" | "granted" | "blocked";
  rowId?: number; level?: PaLevel; by?: string; at?: string; scope?: string | null;
};
export type PaStatus = {
  key: string; label: string; grantable: PaGrantable; viewOnly: boolean; scope: "customers" | "loan_files" | null; scopeEnabled: boolean;
  version: number; counts: { people: number; roles: number }; roles: PaRole[]; always: PaUserRow[]; users: PaUserRow[];
};
export type PaSubjectRole = { slug: string; name: string; members: number; has: boolean; default: PaLevel | null; grant: { id: number; level: PaLevel } | null };
export type PaSubjectUser = {
  id: number; name: string; role: string; roleName: string; trainee: boolean; locked: boolean;
  has: PaLevel | null; blocked: number | null; fromRole: boolean; grantId: number | null; scope: "own" | "team" | "all" | null; scopeAvailable: boolean;
};
export type PaSubjects = { version: number; roles: PaSubjectRole[]; users: PaSubjectUser[] };
export type PaHistSnap = { effect: "allow" | "deny" | null; level: PaLevel | null; scope: string | null };
export type PaHistoryItem = {
  id: number; batch: string; at: string; actor: string; action: "grant" | "update" | "revoke" | "block" | "unblock" | "revert";
  subjectKind: "role" | "user"; subjectName: string; subjectId: number | null; level: PaLevel | null; levelFa: string | null; scope: string | null;
  reverted: boolean; revertOf: string | null; prior?: PaHistSnap | null; result?: PaHistSnap | null;
};
export type PaHistory = { items: PaHistoryItem[]; revertBatch: string | null; version: number };
export class PaError extends Error { constructor(public status: number, public code: string, message: string) { super(message); } }

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${base()}/api${path}`, {
    method, credentials: "include", cache: "no-store",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let j: any = null; try { j = await r.json(); } catch { j = null; }
  if (!r.ok) throw new PaError(r.status, String(j?.error ?? "error"), String(j?.message ?? ""));
  return j as T;
}

export const PA_ME_KEY = ["page-access-me"] as const;
export function usePageAccessMe(enabled: boolean) {
  return useQuery<PaMe>({
    queryKey: PA_ME_KEY, enabled, retry: false, staleTime: 60_000,
    queryFn: async () => { try { return await req<PaMe>("GET", "/page-access/me"); } catch { return { enabled: false }; } },
  });
}
export const paStatus = (key: string) => req<PaStatus>("GET", `/page-access/pages/${encodeURIComponent(key)}`);
export const paSubjects = (key: string) => req<PaSubjects>("GET", `/page-access/pages/${encodeURIComponent(key)}/subjects`);
export const paHistory = (key: string) => req<PaHistory>("GET", `/page-access/pages/${encodeURIComponent(key)}/history`);
type W = { ok: true; batch: string; status: PaStatus };
export const paGrant = (key: string, b: { subjectKind: "role" | "user"; roleSlug?: string; userIds?: number[]; level: PaLevel; scope?: string | null; baseVersion: number }) =>
  req<W>("POST", `/page-access/pages/${encodeURIComponent(key)}/grants`, b);
export const paBlock = (key: string, userId: number, baseVersion: number) => req<W>("POST", `/page-access/pages/${encodeURIComponent(key)}/blocks`, { userId, baseVersion });
export const paRemove = (key: string, rowId: number, baseVersion: number) => req<W>("POST", `/page-access/pages/${encodeURIComponent(key)}/rows/${rowId}/remove`, { baseVersion });
export const paRevert = (key: string, batch: string) => req<W>("POST", `/page-access/pages/${encodeURIComponent(key)}/revert`, { batch });

/** Route pattern → page key (same rule as the server registry: ":x" = one segment, longest pattern wins). */
export function paKeyForPath(pages: PaPageMeta[] | undefined, pathname: string): string | null {
  if (!pages) return null;
  const path = (pathname.split(/[?#]/)[0] || "/").replace(/\/+$/, "") || "/";
  let best: { key: string; len: number } | null = null;
  for (const p of pages) for (const r of p.routes) {
    const re = new RegExp("^" + r.replace(/:[^/]+/g, "[^/]+") + "$");
    if (re.test(path) && (!best || r.length > best.len)) best = { key: p.key, len: r.length };
  }
  return best?.key ?? null;
}

/**
 * Client gate for a non-admin user while the flag is ON. Returns null = keep today's decision unchanged.
 * - «بستن» → closed.  - admin-only page with a grant → open.  - permission page: opened only by its own grant or the role's own
 *   permissions (a grant on «کارهای امروز» that adds customers.view does not light up «مشتریان» in the menu).
 */
export function paDecide(me: PaMe | undefined, pathname: string, needed: string[], today: boolean): boolean | null {
  if (!me?.enabled || me.canManage || !me.pages) return null;
  const key = paKeyForPath(me.pages, pathname); if (!key) return null;
  const page = me.pages.find((p) => p.key === key); if (!page) return null;
  if (me.blocked?.includes(key)) return false;
  if (me.granted?.[key]) return page.kind === "admin" ? true : today;
  if (page.kind === "permission" && needed.length && me.basePermissions) return today && needed.some((x) => me.basePermissions!.includes(x));
  return null;
}
