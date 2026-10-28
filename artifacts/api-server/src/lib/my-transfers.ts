/**
 * Task C (2026-10-26) «تاریخچه‌ی انتقال‌های من»: read-only list of customers that left a salesperson's ownership.
 * Source of truth = customer_priority_history rows with old_salesperson_id = me and a different, non-null
 * new_salesperson_id (qualifier form, «ارتقا به اولویت ۱», automatic non-P1 transfer, admin edit). Derived at read time:
 * no writes, nothing editable. Only the masked name / mobile, the date, the target and current expert and the current
 * stage are returned — no notes, amounts, documents or calls.
 */
import { queryRow, queryRows } from "./crm-db";
import { maskCustomerName, maskCustomerPhone } from "./cross-owner-search";
import { LOAN_STAGE_LABELS } from "./manager-work";

export type MyTransfer = {
  historyId: number; customerId: number; customerName: string; maskedPhone: string; transferredAt: string;
  source: string; sourceLabel: string; byMe: boolean;
  toSalespersonId: number; toSalespersonName: string;
  currentSalespersonId: number | null; currentSalespersonName: string | null;
  stage: string; stageLabel: string;
};

export const TRANSFER_SOURCE_LABELS: Record<string, string> = {
  qualifier_form: "فرم واجد شرایط", expert_upgrade: "ارتقا به اولویت ۱ توسط کارشناس", promote: "ارتقا به اولویت ۱", nonp1_auto_transfer: "انتقال خودکار غیر اولویت ۱",
  customer_update: "ویرایش توسط مدیر",
};
const STATUS_LABELS: Record<string, string> = { in_progress: "در حال پیگیری", completed: "تکمیل شده", cancelled: "لغو شده" };

export function myTransfers(salespersonId: number, actorUserId: number | null, limit = 300): MyTransfer[] {
  if (!queryRow("SELECT 1 x FROM sqlite_master WHERE type='table' AND name='customer_priority_history'")) return [];
  const rows = queryRows<{ hid: number; customer_id: number; name: string | null; phone: string | null; created_at: string; source: string;
    actor_user_id: number | null; to_id: number; to_name: string | null; cur_id: number | null; cur_name: string | null; status: string | null;
    stage: string | null; merged: number | null }>(
    `SELECT h.id hid, h.customer_id, c.name, c.phone, h.created_at, h.source, h.actor_user_id, h.new_salesperson_id to_id, ts.name to_name,
            c.salesperson_id cur_id, cs.name cur_name, c.status, c.merged_into_customer_id merged,
            (SELECT a.stage FROM loan_applications a WHERE a.customer_id=h.customer_id AND a.deleted_at IS NULL ORDER BY a.id DESC LIMIT 1) stage
       FROM customer_priority_history h
       JOIN customers c ON c.id=h.customer_id
       LEFT JOIN salespersons ts ON ts.id=h.new_salesperson_id
       LEFT JOIN salespersons cs ON cs.id=c.salesperson_id
      WHERE h.old_salesperson_id=? AND h.new_salesperson_id IS NOT NULL AND h.new_salesperson_id<>h.old_salesperson_id
      ORDER BY h.created_at DESC, h.id DESC LIMIT ?`, [salespersonId, Math.max(1, Math.min(1000, limit))]);
  return rows.map((r) => {
    const stage = r.stage ? r.stage : `status:${r.status ?? ""}`;
    return {
      historyId: Number(r.hid), customerId: Number(r.customer_id), customerName: maskCustomerName(r.name), maskedPhone: maskCustomerPhone(r.phone),
      transferredAt: r.created_at, source: r.source, sourceLabel: TRANSFER_SOURCE_LABELS[r.source] ?? "انتقال",
      byMe: actorUserId != null && Number(r.actor_user_id) === Number(actorUserId),
      toSalespersonId: Number(r.to_id), toSalespersonName: String(r.to_name ?? "—"),
      currentSalespersonId: r.cur_id == null ? null : Number(r.cur_id), currentSalespersonName: r.cur_name ?? null,
      stage, stageLabel: r.stage ? (LOAN_STAGE_LABELS[r.stage] ?? r.stage) : `بدون پرونده · ${STATUS_LABELS[r.status ?? ""] ?? "—"}`,
    };
  });
}
