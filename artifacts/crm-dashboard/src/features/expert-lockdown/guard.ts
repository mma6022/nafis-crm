/**
 * expert_lockdown client guards (display + query behaviour only).
 * Who is locked is decided solely by the server (/expert-lockdown/me, EL_USERS
 * plus team members via flag.multi_team_v1, trainee exclusion unchanged).
 */
export const EL_ALLOWED_PAGES = [
  "/today",
  "/loan-applications",
  "/payment-orders",
  "/goods-purchases",
  "/messengers",
  "/internal-chat",
  "/bale-bot",
  "/sales-performance",
] as const;

export type ElAllowedPage = (typeof EL_ALLOWED_PAGES)[number];

/** Hide any dock / «بیشتر» href that is not in EL_ALLOWED_PAGES (or the server's allowedPages). */
export function filterLockedNavHrefs(
  hrefs: readonly string[],
  locked: boolean,
  allowedPages: readonly string[] = EL_ALLOWED_PAGES,
): string[] {
  if (!locked) return [...hrefs];
  const allow = new Set(allowedPages);
  return hrefs.filter((h) => {
    const path = (h || "").split("?")[0];
    return allow.has(path);
  });
}

export function navHrefAllowedWhenLocked(href: string, allowedPages: readonly string[] = EL_ALLOWED_PAGES): boolean {
  const path = (href || "").split("?")[0];
  return allowedPages.includes(path);
}

/** A 403 { error: 'expert_lockdown' } must never be retried (unlike expert_lockdown_customer). */
export function isExpertLockdownError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as {
    status?: number;
    code?: string;
    error?: string;
    body?: { error?: string; code?: string };
    response?: { status?: number; data?: { error?: string; code?: string } };
    data?: { error?: string; code?: string };
  };
  const status = e.status ?? e.response?.status;
  if (status !== 403) return false;
  const code = e.code ?? e.error ?? e.body?.error ?? e.body?.code ?? e.response?.data?.error ?? e.response?.data?.code ?? e.data?.error ?? e.data?.code;
  return code === "expert_lockdown";
}

/** Default React Query retry, with an immediate stop on 403 expert_lockdown. */
export function shouldRetryQuery(failureCount: number, error: unknown, max = 3): boolean {
  if (isExpertLockdownError(error)) return false;
  return failureCount < max;
}

/** Locked experts land on /today, never on /. */
export const EL_LOCKDOWN_HOME = "/today";
