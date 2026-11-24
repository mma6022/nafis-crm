/**
 * Dock tweaks for عملکرد من v1.1 (flag.my_performance_v1).
 * When the flag is off, the bottom-nav-v2 slots are returned unchanged.
 * When on (expert dock): «عملکرد من» joins the dock, the golden «الان مشتری جدید دارم»
 * pill is removed, and that action is expected to live under «بیشتر».
 * Admin dock layout is unchanged; the page may still appear under «بیشتر».
 */
import type { Bnv2Input, Bnv2Slots } from '../bottom-nav-v2/layout.ts';
import { bnv2Slots } from '../bottom-nav-v2/layout.ts';

export const MY_WORK_HREF = '/my-work';
export const MP_LABEL = { key: 'mp', label: 'عملکرد من', full: 'عملکرد من', testId: 'mp' } as const;

function pick(visible: Set<string>, hrefs: Array<string | null | undefined>): string[] {
  const out: string[] = [];
  for (const h of hrefs) {
    if (h && visible.has(h) && !out.includes(h)) out.push(h);
  }
  return out;
}

export function applyMyWorkDock(slots: Bnv2Slots, flagOn: boolean, visible: string[]): Bnv2Slots {
  const labels = { ...slots.labels, [MY_WORK_HREF]: { ...MP_LABEL } };
  if (!flagOn) return slots;
  if (slots.kind === 'admin') {
    return { ...slots, labels, used: slots.used.includes(MY_WORK_HREF) ? slots.used : [...slots.used] };
  }
  const isV2 = Boolean(slots.labels['/payment-orders']);
  // Old (pre-v2) dock: only drop the gold pill. Do not invent v2 slots.
  if (!isV2) {
    return { ...slots, primary: false, labels };
  }
  const vis = new Set(visible);
  if (visible.includes(MY_WORK_HREF)) vis.add(MY_WORK_HREF);
  if (!visible.includes(MY_WORK_HREF)) {
    return { ...slots, primary: false, labels };
  }
  const today = slots.before[0] === '/today' || slots.before[0] === '/' ? slots.before[0] : null;
  const before = pick(vis, [today, '/payment-orders', '/loan-applications', '/reminders', MY_WORK_HREF]);
  const after = slots.after.filter((h) => h !== MY_WORK_HREF);
  const tabs = pick(vis, [today, '/payment-orders', MY_WORK_HREF, '/loan-applications']);
  const daily = slots.daily.filter((h) => h !== MY_WORK_HREF);
  const used = Array.from(new Set([...slots.used, MY_WORK_HREF]));
  return {
    ...slots,
    before,
    after,
    tabs,
    daily,
    used,
    primary: false,
    labels,
  };
}

export function myWorkSlots(input: Bnv2Input & { myWork?: boolean }): Bnv2Slots {
  const base = bnv2Slots(input);
  return applyMyWorkDock(base, Boolean(input.myWork), input.visible);
}
