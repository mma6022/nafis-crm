/**
 * 390 tab-bar order for plan-advisor v1 (t378s1460).
 * Flag ON: امروز، پرونده‌ها، ربات بله، دستیار — «دستور پرداخت» moves to بیشتر.
 * Flag OFF: return the live tabs unchanged.
 */
export type PaDockTab = { key: string; href?: string | null; label?: string };

const isToday = (t: PaDockTab) => t.href === "/today" || t.href === "/" || t.key === "today";
const isFiles = (t: PaDockTab) => t.href === "/loan-applications" || t.key === "files";
const isBale = (t: PaDockTab) => t.href === "/bale-bot" || t.key === "bale";
const isPay = (t: PaDockTab) => t.href === "/payment-orders" || t.key === "pay";
const idOf = (t: PaDockTab) => t.href || t.key;

export function pa390DockTabs<T extends PaDockTab>(
  paOn: boolean,
  rawTabs: T[],
  available: T[],
  paItem: T | null,
): { tabs: T[]; movedToMore: T[] } {
  if (!paOn || !paItem) return { tabs: rawTabs, movedToMore: [] };
  const pick = (pred: (t: T) => boolean) => rawTabs.find(pred) ?? available.find(pred);
  const ordered = [pick(isToday), pick(isFiles), pick(isBale), paItem].filter((t): t is T => t != null);
  const tabs: T[] = [];
  const seen = new Set<string>();
  for (const t of ordered) {
    const id = idOf(t);
    if (seen.has(id)) continue;
    seen.add(id);
    tabs.push(t);
  }
  const onDock = new Set(tabs.map(idOf));
  const movedToMore: T[] = [];
  const move = (t: T | undefined) => {
    if (!t) return;
    const id = idOf(t);
    if (onDock.has(id) || movedToMore.some((x) => idOf(x) === id)) return;
    movedToMore.push(t);
  };
  move(pick(isPay));
  for (const t of rawTabs) move(t);
  return { tabs, movedToMore };
}

export const pa390TabHrefs = (tabs: PaDockTab[]) => tabs.map(idOf);
