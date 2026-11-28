/**
 * t978: expose social-hub «پیام‌های آماده» (sh_messages) to the Bale chat API.
 * Flag: flag.bale_sh_messages_v1 (call_queue_settings; only '1' is ON; absent = OFF).
 * OFF → callers omit the `ready` field; sab.quick_messages is unchanged.
 * ON → read-only list of archived=0 messages, plan rows only when loan_plans.active=1, order sort,id.
 * Does not create schema (no write). Missing table → empty list. No category field (waits on design).
 * Never writes loan_plans, contracts, or sh_messages; does not send on its own.
 *
 * t979 v1.1 (Armita's design «پیام‌های آماده — سه زبانه»): flag.quick_replies_v11 (default OFF, only '1' is ON) also exposes the list
 * (it implies the Bale list), adds `category`/`tab`/`showToday` per item and `v11`/`holdMs` on the list, and enables the expert type change
 * (baleShSetType) and the held send + undo in routes/bale-bot.ts. Every surface reads this one source (sh_messages).
 */
import { queryRow, queryRows } from "./crm-db";
import { ensureSocialHubSchema, shCurrentPlanId, shLog, shPlanById, shPlans, type ShCategory, type ShTab } from "./social-hub";
import { executeChanges } from "./crm-db";

export const BALE_SH_FLAG = "flag.bale_sh_messages_v1";
const setting = (k: string): string | null => {
  try { return queryRow<{ value: string }>("SELECT value FROM call_queue_settings WHERE key=?", [k])?.value ?? null; } catch { return null; }
};
export const QR_FLAG = "flag.quick_replies_v11";
export const qrOn = () => setting(QR_FLAG) === "1";
/** Bale list is available when either flag is ON (v1.1 implies it). */
export const baleShOn = () => setting(BALE_SH_FLAG) === "1" || qrOn();
/** Undo window of a direct send in the Bale chat: the message is held this long before the worker sends it (v1.1 only). */
export const QR_HOLD_MS = 6000;

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
  /** v1.1 only (flag.quick_replies_v11): the one tab the message lives in, its free-message category and its «نمایش در کارهای امروز». */
  tab?: ShTab;
  category?: ShCategory | null;
  showToday?: boolean;
};
export type BaleShReady = {
  currentPlanId: number | null;
  currentPlanTitle: string | null;
  items: BaleShItem[];
  v11?: boolean;
  holdMs?: number;
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
  if (!tableReady()) return { currentPlanId, currentPlanTitle, items: [], ...(qrOn() ? { v11: true, holdMs: QR_HOLD_MS } : {}) };
  const v11 = qrOn();
  const meta = v11 ? { v11: true, holdMs: QR_HOLD_MS } : {};
  let rows: { id: number; kind: string; plan_id: number | null; title: string; body: string; category?: string | null; show_today?: number }[] = [];
  try {
    rows = queryRows("SELECT * FROM sh_messages WHERE archived=0 ORDER BY sort, id");
  } catch { return { currentPlanId, currentPlanTitle, items: [], ...meta }; }
  const plans = new Map<number, string>();
  try { for (const p of shPlans()) plans.set(p.id, p.name); } catch { /* loan_plans unreadable → plan items dropped */ }
  const items: BaleShItem[] = [];
  for (const r of rows) {
    const kind = r.kind === "plan" ? "plan" : r.kind === "free" ? "free" : null;
    if (!kind) continue;
    const planId = r.plan_id == null ? null : Number(r.plan_id);
    if (kind === "plan") {
      if (planId == null || !plans.has(planId)) continue;
      items.push({ id: Number(r.id), kind, planId, planTitle: plans.get(planId) ?? null, title: String(r.title), body: String(r.body),
        ...(v11 ? { tab: "plans" as const, category: null, showToday: Number(r.show_today) === 1 } : {}) });
    } else {
      const cat: ShCategory = r.category === "educational" ? "educational" : "general";
      items.push({ id: Number(r.id), kind, planId: null, planTitle: null, title: String(r.title), body: String(r.body),
        ...(v11 ? { tab: cat, category: cat, showToday: Number(r.show_today) === 1 } : {}) });
    }
  }
  return { currentPlanId, currentPlanTitle, items, ...meta };
}

export function baleShItemById(id: number): BaleShItem | null {
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return baleShReady(null).items.find((x) => x.id === id) ?? null;
}

export class QrError extends Error { constructor(public status: number, public code: string) { super(code); } }

/** v1.1 (design §4): an expert changes a message's type in the preview. One message lives in exactly one tab; moving it takes it out of the
 *  old tab. «طرح‌ها» needs an active plan. Moving a plan message to general/educational clears its auto-send (free messages never auto-send;
 *  the table's CHECK requires it). Only the one sh_messages row changes; nothing is sent. Needs flag.quick_replies_v11. */
export function baleShSetType(u: { id: number }, id: number, tab: string, planId?: number | null): BaleShItem {
  if (!qrOn()) throw new QrError(404, "flag_off");
  if (!Number.isSafeInteger(id) || id <= 0) throw new QrError(404, "not_found");
  if (tab !== "plans" && tab !== "general" && tab !== "educational") throw new QrError(400, "tab_invalid");
  ensureSocialHubSchema();
  const row = queryRow<{ id: number }>("SELECT id FROM sh_messages WHERE id=? AND archived=0", [id]);
  if (!row) throw new QrError(404, "not_found");
  if (tab === "plans") {
    const pid = Number(planId);
    if (!Number.isSafeInteger(pid) || pid <= 0 || !shPlans().some((p) => p.id === pid)) throw new QrError(400, "plan_required");
    executeChanges("UPDATE sh_messages SET kind='plan', plan_id=?, category='general', updated_by=?, updated_at=? WHERE id=?", [pid, u.id, new Date().toISOString(), id]);
  } else {
    executeChanges("UPDATE sh_messages SET kind='free', plan_id=NULL, auto_send=0, category=?, updated_by=?, updated_at=? WHERE id=?", [tab, u.id, new Date().toISOString(), id]);
  }
  shLog(u.id, "message_type", id, { tab, planId: tab === "plans" ? Number(planId) : null });
  const it = baleShReady(null).items.find((x) => x.id === id);
  if (!it) throw new QrError(404, "not_found");
  return it;
}
