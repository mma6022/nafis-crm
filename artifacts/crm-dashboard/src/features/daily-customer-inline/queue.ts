/** Merge due reminders from the existing GET /reminders list into the today queue. No new server fields. */
import type { Reminder } from "@workspace/api-client-react";
import type { DciTask } from "./api";

const FD = "۰۱۲۳۴۵۶۷۸۹";
const fd = (v: string | number) => String(v).replace(/[0-9]/g, (d) => FD[Number(d)]);

export type QueueTask = DciTask & {
  turn: number;
  overdue?: boolean;
  remText?: string;
  reminderId?: number;
  types: string[];
};

export function remClock(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return fd(new Intl.DateTimeFormat("fa-IR", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Tehran" }).format(d));
}

export function isDueReminder(r: Reminder, now = Date.now()): boolean {
  if (r.done || r.customerId == null) return false;
  const at = Date.parse(r.remindAt);
  return Number.isFinite(at) && at <= now;
}

export function isOverdueReminder(r: Reminder, now = Date.now()): boolean {
  if (r.done || r.customerId == null) return false;
  const at = Date.parse(r.remindAt);
  return Number.isFinite(at) && at < now;
}

export function mergeQueue(tasks: DciTask[], reminders: Reminder[] | undefined, now = Date.now()): QueueTask[] {
  const out: QueueTask[] = tasks.map((t) => ({
    ...t,
    turn: 0,
    types: [t.typ],
    remText: t.typ === "یادآور" ? undefined : undefined,
  }));
  const due = (reminders ?? []).filter((r) => isDueReminder(r, now));
  for (const r of due) {
    const cid = Number(r.customerId);
    const text = String(r.message || r.subject || "").trim();
    const overdue = isOverdueReminder(r, now);
    const existing = out.find((t) => t.customerId === cid);
    if (existing) {
      if (!existing.types.includes("یادآور")) existing.types.push("یادآور");
      existing.remText = existing.remText || text;
      existing.reminderId = existing.reminderId ?? r.id;
      existing.overdue = existing.overdue || overdue;
      if (!existing.at || r.remindAt < existing.at) {
        existing.at = r.remindAt;
        existing.tm = remClock(r.remindAt);
      }
    } else {
      out.push({
        id: `rem-${r.id}`,
        kind: "plan",
        itemId: null,
        customerId: cid,
        name: String(r.customerName ?? ""),
        typ: "یادآور",
        ic: "i-bell",
        tm: remClock(r.remindAt),
        at: r.remindAt,
        status: overdue ? "overdue" : "due",
        turn: 0,
        overdue,
        remText: text,
        reminderId: r.id,
        types: ["یادآور"],
      });
    }
  }
  out.sort((a, b) => String(a.at ?? "").localeCompare(String(b.at ?? "")));
  return out.map((t, i) => ({ ...t, turn: i + 1 }));
}

export function queueKindClass(t: Pick<QueueTask, "typ" | "types">): "is-lead" | "is-rem" | "is-both" | "is-today" {
  const types = t.types?.length ? t.types : [t.typ];
  const hasLead = types.includes("لید تازه");
  const hasRem = types.includes("یادآور");
  if (hasLead && hasRem) return "is-both";
  if (hasRem && !hasLead) return "is-rem";
  if (types.includes("کار امروز") || t.typ === "کار امروز") return "is-today";
  return "is-lead";
}

export function queueKindLabel(t: Pick<QueueTask, "typ" | "types">): string {
  const k = queueKindClass(t);
  if (k === "is-both") return "لید تازه و یادآور";
  if (k === "is-rem") return "یادآور";
  if (k === "is-today") return "کار امروز";
  return t.typ;
}
