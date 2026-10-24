/**
 * crm-kazemi-source (display only): where a customer's current salesperson got them from.
 *  - «از کاظمی» (from_kazemi): the customer left the qualifier's (Kazemi's) ownership at least once and is now with another
 *    salesperson. Source of truth = customer_priority_history rows with old_salesperson_id = qualifier and a different
 *    new_salesperson_id (P1 auto-handoff «qualifier_form», manual «ارتقا به اولویت ۱» «promote», or an admin edit
 *    «customer_update»). The 848 bulk move Hasani/Ghasemi → Kazemi (team_sales_transfer_snapshot) is a move TO Kazemi
 *    and therefore never counts.
 *  - «مشتری قبلی» (previous): owned by a salesperson other than Kazemi and never handed off by Kazemi.
 *  - null: owned by Kazemi, unassigned, or unknown.
 * Derived at read time: no table, no writes. Never used by commission, ownership or allocation code.
 */
import { queryRow, queryRows } from "./crm-db";
import { ensureTeamSalesSchema, getTeamSalesConfig } from "./team-sales";

export type KazemiSourceKind = "from_kazemi" | "previous";
export type KazemiMechanism = "qualifier_form" | "promote" | "customer_update" | "other";
export type KazemiSource = {
  kind: KazemiSourceKind;
  /** ISO time Kazemi handed the customer off (latest hand-off); null for «مشتری قبلی». */
  handoffAt: string | null;
  mechanism: KazemiMechanism | null;
  /** Salesperson the customer went to from Kazemi (can differ from the current one after a later reassignment). */
  handoffToSalespersonId: number | null;
  /** The customer was with the current salesperson before Kazemi got them, and came back. */
  returned: boolean;
};

export function kazemiSalespersonId(): number | null {
  try {
    const id = Number(getTeamSalesConfig().qualifierSalespersonId);
    return Number.isInteger(id) && id > 0 ? id : null;
  } catch { return null; }
}

function tableExists(name: string): boolean {
  return !!queryRow("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name=?", [name]);
}

/** SQL fragment for the «منبع» list filter. Alias `c` = customers. Returns null for «همه» / unknown values. */
export function kazemiSourceFilterSql(source: unknown): { sql: string; params: number[] } | null {
  if (source !== "from_kazemi" && source !== "previous") return null;
  const k = kazemiSalespersonId();
  if (k == null) return { sql: "0", params: [] };
  ensureTeamSalesSchema();
  const exit = `EXISTS (SELECT 1 FROM customer_priority_history kzh WHERE kzh.customer_id=c.id
    AND kzh.old_salesperson_id=? AND kzh.new_salesperson_id IS NOT NULL AND kzh.new_salesperson_id<>?)`;
  return {
    sql: `(c.salesperson_id IS NOT NULL AND c.salesperson_id<>? AND ${source === "previous" ? "NOT " : ""}${exit})`,
    params: [k, k, k],
  };
}

type HistRow = { id: number; customer_id: number; old_salesperson_id: number | null; new_salesperson_id: number | null; source: string; created_at: string };

/** Labels for the given customers (current owner read from customers). Missing key = no chip. */
export function kazemiSources(customerIds: number[]): Map<number, KazemiSource> {
  const out = new Map<number, KazemiSource>();
  const ids = [...new Set(customerIds.map(Number).filter((id) => Number.isInteger(id) && id > 0))];
  const k = kazemiSalespersonId();
  if (!ids.length || k == null) return out;
  ensureTeamSalesSchema();
  const hasBulk = tableExists("team_sales_transfer_snapshot");
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const ph = chunk.map(() => "?").join(",");
    const owners = queryRows<{ id: number; salesperson_id: number | null }>(
      `SELECT id, salesperson_id FROM customers WHERE id IN (${ph})`, chunk);
    const hist = queryRows<HistRow>(
      `SELECT id, customer_id, old_salesperson_id, new_salesperson_id, source, created_at FROM customer_priority_history
       WHERE customer_id IN (${ph}) AND (old_salesperson_id=? OR new_salesperson_id=?) ORDER BY id`, [...chunk, k, k]);
    const bulk = hasBulk ? queryRows<{ customer_id: number; previous_salesperson_id: number | null; created_at: string }>(
      `SELECT customer_id, previous_salesperson_id, created_at FROM team_sales_transfer_snapshot
       WHERE customer_id IN (${ph}) AND new_salesperson_id=? AND rolled_back_at IS NULL ORDER BY id`, [...chunk, k]) : [];
    const histBy = new Map<number, HistRow[]>();
    for (const h of hist) { const l = histBy.get(Number(h.customer_id)) ?? []; l.push(h); histBy.set(Number(h.customer_id), l); }
    for (const o of owners) {
      const cur = o.salesperson_id == null ? null : Number(o.salesperson_id);
      if (cur == null || cur === k) continue;
      const rows = histBy.get(Number(o.id)) ?? [];
      const exits = rows.filter((h) => Number(h.old_salesperson_id) === k && h.new_salesperson_id != null && Number(h.new_salesperson_id) !== k);
      const last = exits[exits.length - 1];
      if (!last) { out.set(Number(o.id), { kind: "previous", handoffAt: null, mechanism: null, handoffToSalespersonId: null, returned: false }); continue; }
      // Who had the customer right before this Kazemi stint: the latest move INTO Kazemi before the exit
      // (a history row, or the 848 bulk snapshot), whichever is later.
      const into = rows.filter((h) => h.id < last.id && Number(h.new_salesperson_id) === k && Number(h.old_salesperson_id) !== k).pop();
      const b = bulk.filter((x) => Number(x.customer_id) === Number(o.id) && x.created_at <= last.created_at).pop();
      let before: number | null = null;
      if (into && (!b || into.created_at >= b.created_at)) before = into.old_salesperson_id == null ? null : Number(into.old_salesperson_id);
      else if (b) before = b.previous_salesperson_id == null ? null : Number(b.previous_salesperson_id);
      const mech: KazemiMechanism = last.source === "qualifier_form" || last.source === "promote" || last.source === "customer_update" ? last.source : "other";
      out.set(Number(o.id), {
        kind: "from_kazemi", handoffAt: last.created_at, mechanism: mech,
        handoffToSalespersonId: Number(last.new_salesperson_id), returned: before != null && before === cur,
      });
    }
  }
  return out;
}

export function kazemiSourceOf(customerId: number): KazemiSource | null {
  return kazemiSources([customerId]).get(customerId) ?? null;
}
