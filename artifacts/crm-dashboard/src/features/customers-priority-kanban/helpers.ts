/** customers-priority-kanban v1 helpers (flag.customers_priority_kanban_v1). No customer name or phone is stored. */

export const CPK_FLAG = "flag.customers_priority_kanban_v1";
export const CPK_PAGE = 15;
export const CPK_UNDO_MS = 6000;

/** Locked to the approved design (spec §2.2 / §6.6) — same red/orange/green/grey language as the today chips. */
export const CPK_COLUMNS = [
  { value: 1 as number | null, key: "1", label: "اولویت ۱", color: "#B42318", bg: "#FEF0EE" },
  { value: 2 as number | null, key: "2", label: "اولویت ۲", color: "#E07A2A", bg: "#FFF3E8" },
  { value: 3 as number | null, key: "3", label: "اولویت ۳", color: "#1F7A4D", bg: "#E8F5EE" },
  { value: null as number | null, key: "0", label: "بدون اولویت", color: "#9AA3B8", bg: "#EFF1F8" },
] as const;

export type CpkView = "table" | "board";

export const cpkViewKey = (userId: number) => `nafis.customers.priorityKanban.view.${userId}`;

export function readCpkView(userId: number | undefined | null): CpkView {
  if (!userId) return "table";
  try {
    const v = localStorage.getItem(cpkViewKey(userId));
    return v === "board" || v === "table" ? v : "table";
  } catch {
    return "table";
  }
}

export function writeCpkView(userId: number | undefined | null, view: CpkView): void {
  if (!userId) return;
  try { localStorage.setItem(cpkViewKey(userId), view); } catch { /* private mode / quota */ }
}

export const faNum = (n: number) => n.toLocaleString("fa-IR");

export function cpkMoreLabel(remaining: number): string {
  return `${faNum(remaining)} مورد دیگر — بیشتر`;
}

export function cpkColumnsForFilter(priority: string): typeof CPK_COLUMNS[number][] {
  if (!priority) return [...CPK_COLUMNS];
  if (priority === "null") return CPK_COLUMNS.filter((c) => c.value === null);
  const n = Number(priority);
  return CPK_COLUMNS.filter((c) => c.value === n);
}

export function cpkColumnLabel(value: number | null): string {
  return CPK_COLUMNS.find((c) => c.value === value)?.label ?? "بدون اولویت";
}

/** «۲۸ آبان، ساعت ۱۰:۰۰» in Asia/Tehran. Returns null when the value is missing or unparsable. */
export function formatFollowUp(value?: string | null, now = new Date()): string | null {
  void now;
  if (!value) return null;
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return null;
  const date = new Intl.DateTimeFormat("fa-IR-u-ca-persian", { month: "long", day: "numeric", timeZone: "Asia/Tehran" }).format(d);
  const time = new Intl.DateTimeFormat("fa-IR", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Tehran" }).format(d);
  return `${date}، ساعت ${time}`;
}

export function cpkUndoMessage(name: string, next: number | null): string {
  return `اولویتِ ${name} به ${cpkColumnLabel(next)} تغییر کرد.`;
}
