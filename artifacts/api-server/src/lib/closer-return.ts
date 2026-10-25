/**
 * crm-kz-return (Mohammad 2026-10-25 16:50; PM spec): when Kazemi (the qualifier) upgrades a customer to P1 and hands
 * it to a closer, the customer goes BACK to its last previous main expert (Hasani → Hasani, Ghasemi → Ghasemi).
 * Only when there is no usable previous expert does the existing fair split (round-robin cursor) decide.
 *
 * Ownership timeline (no guessing; only recorded moves):
 *  - the customer's current owner (salesperson_id) — "now";
 *  - customer_priority_history rows (every source: customer_update, promote, qualifier_form, first_call_edit,
 *    no_answer_archive, nonp1_auto_transfer): new_salesperson_id at created_at, old_salesperson_id just before it;
 *  - team_sales_transfer_snapshot rows not rolled back (batch teamsales-20261024-0126, 848 customers):
 *    new_salesperson_id at created_at, previous_salesperson_id just before it.
 * Walk it newest → oldest and return the customer to the MOST RECENT ACTIVE MAIN EXPERT (PM answer 2026-10-25 17:57):
 * skip NULL, the qualifier (Kazemi), trainees (5 / 19 / 20), anyone who is not a configured closer, and closers that are
 * inactive now. The first configured, active closer met wins → reason «کارشناس قبلی مشتری».
 * Only if none exists → fair split, reason «تقسیم عادلانه» (never_had_expert: no other owner recorded at all;
 * no_active_expert: only trainees / non-closers / inactive closers recorded).
 * e.g. Ghasemi → trainee 20 → Kazemi goes back to Ghasemi.
 * A return does NOT advance the round-robin cursor, so it never counts toward that closer's fair-split quota.
 */
import { queryRow, queryRows } from "./crm-db";
import { NONP1_TRAINEE_SALESPERSON_IDS } from "./nonp1-transfer";

export const CLOSER_RETURN_PREVIOUS_LABEL = "کارشناس قبلی مشتری" as const;
export const CLOSER_RETURN_FAIR_LABEL = "تقسیم عادلانه" as const;

export type CloserChoice =
  | { kind: "previous_expert"; salespersonId: number; label: typeof CLOSER_RETURN_PREVIOUS_LABEL; evidence: string }
  | { kind: "fair_split"; label: typeof CLOSER_RETURN_FAIR_LABEL;
      why: "never_had_expert" | "no_active_expert"; previousSalespersonId: number | null };

type Obs = { at: string; ord: number; sp: number | null; evidence: string };

const tableExists = (name: string) => Boolean(queryRow("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", [name]));

/** Recorded owners of a customer, newest first. Pure read. */
export function ownershipTimeline(customerId: number, currentSalespersonId: number | null): Obs[] {
  const obs: Obs[] = [];
  if (tableExists("customer_priority_history")) {
    for (const r of queryRows<{ id: number; old_salesperson_id: number | null; new_salesperson_id: number | null; source: string; created_at: string }>(
      "SELECT id, old_salesperson_id, new_salesperson_id, source, created_at FROM customer_priority_history WHERE customer_id=?", [customerId])) {
      obs.push({ at: r.created_at, ord: 1, sp: r.new_salesperson_id == null ? null : Number(r.new_salesperson_id), evidence: `history#${r.id}:${r.source}:new` });
      obs.push({ at: r.created_at, ord: 0, sp: r.old_salesperson_id == null ? null : Number(r.old_salesperson_id), evidence: `history#${r.id}:${r.source}:old` });
    }
  }
  if (tableExists("team_sales_transfer_snapshot")) {
    for (const r of queryRows<{ id: number; batch: string; previous_salesperson_id: number | null; new_salesperson_id: number; created_at: string }>(
      "SELECT id, batch, previous_salesperson_id, new_salesperson_id, created_at FROM team_sales_transfer_snapshot WHERE customer_id=? AND rolled_back_at IS NULL",
      [customerId])) {
      obs.push({ at: r.created_at, ord: 1, sp: Number(r.new_salesperson_id), evidence: `batch:${r.batch}:new` });
      obs.push({ at: r.created_at, ord: 0, sp: r.previous_salesperson_id == null ? null : Number(r.previous_salesperson_id), evidence: `batch:${r.batch}:old` });
    }
  }
  // newest first; at the same instant the state AFTER a move (ord 1) is newer than the one before it (ord 0)
  const t = (s: string) => { const v = Date.parse(s.includes("T") ? s : `${s.replace(" ", "T")}Z`); return Number.isFinite(v) ? v : 0; };
  obs.sort((a, b) => (t(b.at) - t(a.at)) || (b.ord - a.ord));
  return [{ at: "9999", ord: 2, sp: currentSalespersonId, evidence: "current_owner" }, ...obs];
}

/** Decide the closer for a qualifier → closer hand-off WITHOUT reserving anything. Pure read. */
export function chooseCloserFor(customerId: number, currentSalespersonId: number | null,
  cfg: { qualifierSalespersonId: number | null; closerSalespersonIds: number[] }): CloserChoice {
  const q = cfg.qualifierSalespersonId == null ? null : Number(cfg.qualifierSalespersonId);
  const closers = cfg.closerSalespersonIds.map(Number);
  const activeCache = new Map<number, boolean>();
  const isActive = (sp: number) => {
    if (!activeCache.has(sp)) { const r = queryRow<{ a: number }>("SELECT active AS a FROM salespersons WHERE id=?", [sp]); activeCache.set(sp, Boolean(r) && Number(r!.a) === 1); }
    return activeCache.get(sp)!;
  };
  const others = ownershipTimeline(customerId, currentSalespersonId).filter((o) => o.sp != null && o.sp !== q);
  const hit = others.find((o) => !NONP1_TRAINEE_SALESPERSON_IDS.includes(o.sp!) && closers.includes(o.sp!) && isActive(o.sp!));
  if (hit) return { kind: "previous_expert", salespersonId: hit.sp!, label: CLOSER_RETURN_PREVIOUS_LABEL, evidence: hit.evidence };
  return { kind: "fair_split", label: CLOSER_RETURN_FAIR_LABEL, why: others.length ? "no_active_expert" : "never_had_expert",
    previousSalespersonId: others.length ? others[0].sp : null };
}
