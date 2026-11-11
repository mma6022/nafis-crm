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

function absorb(existing: QueueTask, typ: string, extra?: Partial<QueueTask>): void {
  if (typ && !existing.types.includes(typ)) existing.types.push(typ);
  if (extra?.remText && !existing.remText) existing.remText = extra.remText;
  if (extra?.reminderId != null && existing.reminderId == null) existing.reminderId = extra.reminderId;
  if (extra?.overdue) existing.overdue = true;
  if (extra?.at && (!existing.at || extra.at < existing.at)) {
    existing.at = extra.at;
    if (extra.tm) existing.tm = extra.tm;
  }
  if (extra?.name && !existing.name) existing.name = extra.name;
}

export function mergeQueue(tasks: DciTask[], reminders: Reminder[] | undefined, now = Date.now()): QueueTask[] {
  const byCust = new Map<number, QueueTask>();
  const out: QueueTask[] = [];
  const add = (t: QueueTask) => {
    const existing = byCust.get(t.customerId);
    if (existing) {
      for (const typ of t.types) absorb(existing, typ, t);
      return;
    }
    byCust.set(t.customerId, t);
    out.push(t);
  };
  for (const t of tasks) {
    add({
      ...t,
      turn: 0,
      types: [t.typ],
      remText: undefined,
    });
  }
  const due = (reminders ?? []).filter((r) => isDueReminder(r, now));
  for (const r of due) {
    const cid = Number(r.customerId);
    const text = String(r.message || r.subject || "").trim();
    const overdue = isOverdueReminder(r, now);
    add({
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
  const types = t.types?.length ? t.types : [t.typ];
  const uniq: string[] = [];
  for (const x of types) if (x && !uniq.includes(x)) uniq.push(x);
  const hasRem = uniq.includes("یادآور");
  const others = uniq.filter((x) => x !== "یادآور");
  if (hasRem && others.length) return `${others.join(" و ")} و یادآور`;
  if (hasRem) return "یادآور";
  if (uniq.length > 1) return uniq.join(" و ");
  if (uniq[0] === "کار امروز") return "کار امروز";
  return uniq[0] || t.typ;
}
