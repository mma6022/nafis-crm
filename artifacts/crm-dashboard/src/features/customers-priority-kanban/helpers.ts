/** customers-priority-kanban v1 helpers (flag.customers_priority_kanban_v1). No customer name or phone is stored. */

export const CPK_FLAG = "flag.customers_priority_kanban_v1";
export const CPK_PAGE = 15;
export const CPK_UNDO_MS = 6000;

/** Locked to the live today-page chips (today-layout.css .dci-chip-p). Header tints are 10% mixes of the same inks. */
export const CPK_COLUMNS = [
  { value: 1 as number | null, key: "1", label: "اولویت ۱", color: "#B42318", bg: "#F2DCDA" },
  { value: 2 as number | null, key: "2", label: "اولویت ۲", color: "#B54708", bg: "#F2E1D8" },
  { value: 3 as number | null, key: "3", label: "اولویت ۳", color: "#1F7A4D", bg: "#DCE8E2" },
  { value: null as number | null, key: "0", label: "بدون اولویت", color: "#667085", bg: "#E3E5E8" },
] as const;

export type CpkView = "table" | "board";

export const cpkViewKey = (userId: number) => `nafis.customers.priorityKanban.view.${userId}`;

/** t863u (Mohammad: «پیش فرض نمایش مشتریان من رو باید بورد بکنی»): every fresh open of «مشتریان من» starts on the board.
 *  A «فهرست» pick lives only in the page's component state for that visit; nothing is saved across visits. */
export const CUSTOMERS_DEFAULT_VIEW: CpkView = "board";

/** One-time migration: the old lasting pick (localStorage, default "table") made the list win on every open.
 *  Remove any stored value for this user so it can never come back. Never throws. */
export function clearStaleCpkView(userId: number | undefined | null): void {
  if (!userId) return;
  try { localStorage.removeItem(cpkViewKey(userId)); } catch { /* private mode */ }
}

export const faNum = (n: number) => n.toLocaleString("fa-IR");

const FA_DIGITS = "۰۱۲۳۴۵۶۷۸۹";
/** Last four phone digits in Persian, for the locked short-list mask (no full number). */
export function formatPhoneLast4(last4: string): string {
  return String(last4).replace(/[0-9]/g, (d) => FA_DIGITS[Number(d)]!)
    .replace(/[٠-٩]/g, (d) => FA_DIGITS["٠١٢٣٤٥٦٧٨٩".indexOf(d)]!);
}

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

/** Always a relative phrase («۳ روز پیش», «دیروز») — never a Jalali calendar date. */
export function formatLastCall(value?: string | null, now = new Date()): string | null {
  if (!value) return null;
  const t = new Date(value).getTime();
  if (!Number.isFinite(t)) return null;
  const diff = Math.max(0, now.getTime() - t) / 1000;
  if (diff < 60) return "همین حالا";
  if (diff < 3600) return `${faNum(Math.floor(diff / 60))} دقیقه پیش`;
  if (diff < 86400) return `${faNum(Math.floor(diff / 3600))} ساعت پیش`;
  const days = Math.floor(diff / 86400);
  if (days === 1) return "دیروز";
  return `${faNum(days)} روز پیش`;
}

export function cpkUndoMessage(name: string, next: number | null): string {
  return `اولویتِ ${name} به ${cpkColumnLabel(next)} تغییر کرد.`;
}
