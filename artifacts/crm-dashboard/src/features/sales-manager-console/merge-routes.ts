// «مدیریت فروش» v1.2 (merge-v1.2.md §4): old URL → anchor on /sales-admin. Used only while /api/sales-admin/me says merged (flag.sales_admin_merge_v12 ON)
// and the user may open the page. OFF, or an expert: null → the old page renders exactly as today.
// Kept on purpose (Mohammad t355s1298 §6-23: «رویدادهای صف در گزارش‌ها می‌ماند»): /call-queue-events and /daily-plans/report.
export function mergedTarget(pathname: string, search = '', hash = '', opts: { bale?: boolean } = {}): string | null {
  const p = pathname.replace(/\/+$/, '') || '/';
  // v1.3 (flag.sales_admin_bale_v13): the old Bale admin page; the server answers a direct load with 301 → same target.
  if (p === '/bale-bot/admin') return opts.bale ? '/sales-admin#s-bale' : null;
  const anchor = (id: string, q = '') => `/sales-admin${q ? `?${q}` : ''}#s-${id}`;
  if (p === '/sales-team-admin') {
    const h = /^#s-[a-z]+$/.test(hash) ? hash : '';
    const q = new URLSearchParams(search); const open = q.get('open');
    return `/sales-admin${open ? `?open=${encodeURIComponent(open)}` : ''}${h}`;
  }
  if (p === '/sales-teams') return anchor('teams');
  if (p === '/settings/default-owner') return anchor('dist');
  if (p === '/settings/call-queue' || p === '/sales-assist-settings') return anchor('model');
  if (p === '/daily-plans' || p === '/daily-plans/settings') return anchor('daily');
  let m = /^\/daily-plans\/expert\/(\d+)\/(\d{4}-\d{2}-\d{2})$/.exec(p);
  if (m) return anchor('daily', `expert=${m[1]}&date=${m[2]}`);
  m = /^\/daily-plans\/capacity\/(\d+)$/.exec(p);
  if (m) return anchor('daily', `capacity=${m[1]}`);
  if (p === '/call-queue-discipline') return anchor('discipline');
  return null;
}
/** Every old path the router wraps (for the redirect test and the nav). */
export const MERGED_OLD_PATHS = ['/sales-team-admin', '/sales-teams', '/settings/default-owner', '/settings/call-queue', '/sales-assist-settings', '/daily-plans', '/daily-plans/settings', '/daily-plans/expert/:sp/:date', '/daily-plans/capacity/:sp', '/call-queue-discipline'];
export const KEPT_OLD_PATHS = ['/call-queue-events', '/daily-plans/report'];
/** v1.3 only while /api/sales-admin/me says bale (flag.sales_admin_bale_v13 + console flags). /bale-bot (inbox), /settings/bale, /bale/autoreply, /call-center, /voice-notes-usage stay. */
export const BALE_OLD_PATHS = ['/bale-bot/admin'];
