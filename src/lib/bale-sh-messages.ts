/**
 * t978: expose social-hub «پیام‌های آماده» (sh_messages) to the Bale chat API.
 * Flag: flag.bale_sh_messages_v1 (call_queue_settings; only '1' is ON; absent = OFF).
 * OFF → callers omit the `ready` field; sab.quick_messages is unchanged.
 * ON → read-only list of archived=0 messages, plan rows only when loan_plans.active=1, order sort,id.
 * Does not create schema (no write). Missing table → empty list. No category field (waits on design).
 * Never writes loan_plans, contracts, or sh_messages; does not send on its own.
 */
import { queryRow, queryRows } from "./crm-db";
import { shCurrentPlanId, shPlanById, shPlans } from "./social-hub";

export const BALE_SH_FLAG = "flag.bale_sh_messages_v1";
const setting = (k: string): string | null => {
  try { return queryRow<{ value: string }>("SELECT value FROM call_queue_settings WHERE key=?", [k])?.value ?? null; } catch { return null; }
};
export const baleShOn = () => setting(BALE_SH_FLAG) === "1";

const tableReady = (): boolean => {
  try { return !!queryRow("SELECT 1 x FROM sqlite_master WHERE type='table' AND name='sh_messages'"); } catch { return false; }
};

export type BaleShItem = {
  id: number;
  kind: "free" | "plan";
  planId: number | null;
  planTitle: string | null;
  title: string;
  body: string;
};
export type BaleShReady = {
  currentPlanId: number | null;
  currentPlanTitle: string | null;
  items: BaleShItem[];
};

export function baleShReady(customerId?: number | null): BaleShReady {
  let currentPlanId: number | null = null;
  let currentPlanTitle: string | null = null;
  if (customerId && Number.isSafeInteger(customerId) && customerId > 0) {
    try { currentPlanId = shCurrentPlanId(customerId); } catch { currentPlanId = null; }
    if (currentPlanId != null) {
      try { currentPlanTitle = shPlanById(currentPlanId)?.name ?? null; } catch { currentPlanTitle = null; }
    }
  }
  if (!tableReady()) return { currentPlanId, currentPlanTitle, items: [] };
  let rows: { id: number; kind: string; plan_id: number | null; title: string; body: string }[] = [];
  try {
    rows = queryRows("SELECT id, kind, plan_id, title, body FROM sh_messages WHERE archived=0 ORDER BY sort, id");
  } catch { return { currentPlanId, currentPlanTitle, items: [] }; }
  const plans = new Map<number, string>();
  try { for (const p of shPlans()) plans.set(p.id, p.name); } catch { /* loan_plans unreadable → plan items dropped */ }
  const items: BaleShItem[] = [];
  for (const r of rows) {
    const kind = r.kind === "plan" ? "plan" : r.kind === "free" ? "free" : null;
    if (!kind) continue;
    const planId = r.plan_id == null ? null : Number(r.plan_id);
    if (kind === "plan") {
      if (planId == null || !plans.has(planId)) continue;
      items.push({ id: Number(r.id), kind, planId, planTitle: plans.get(planId) ?? null, title: String(r.title), body: String(r.body) });
    } else {
      items.push({ id: Number(r.id), kind, planId: null, planTitle: null, title: String(r.title), body: String(r.body) });
    }
  }
  return { currentPlanId, currentPlanTitle, items };
}

export function baleShItemById(id: number): BaleShItem | null {
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return baleShReady(null).items.find((x) => x.id === id) ?? null;
}
