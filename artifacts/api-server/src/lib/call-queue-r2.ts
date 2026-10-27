/**
 * crm-call-queue R2 (spec v1.6 §7ج, §8-16…36): «قفل تماس», «به‌موقع», امتیاز نظم پیگیری, پنل محدود, هشدار ۳ روز کاری, سیگنال‌های گزارش روزانه.
 * Every path is behind its own call_queue_settings flag, seeded '0' (OFF). OFF = no rows written, endpoints answer {enabled:false}.
 * Display only: the score has no effect on salary, commission or fees. Nothing here sends SMS, Bale or any customer/staff message;
 * the only notification is a CRM bell row (flag.alerts). Only CRM-button calls (call_queue_calls) count. User 29 never; trainees
 * (users 6/27/28, sp 5/19/20) are not eligible in this build (same rule as R1, see cqEligible).
 */
import { crmDb, execute, executeChanges, queryRow, queryRows } from "./crm-db";
import {
  CQ_EXCLUDED_USER_IDS, cqDisciplineSettings, cqDue, cqEligible, cqEvent, cqFlags, cqLockOn, cqManagerIds, cqOnTime, cqOwnedCustomerSql, cqPendingCall,
  ensureCallQueueSchema, fromTehran, isWorkDay, tParts, tYmd, type CqUser, type TParts,
} from "./call-queue";
import { dpOverdueExtra } from "./daily-plan";

const dayRange = (ymd: string) => { const [y, m, d] = ymd.split("-").map(Number); const from = fromTehran(y, m, d); return { from: from.toISOString(), to: new Date(from.getTime() + 86_400_000).toISOString() }; };
const ymdParts = (ymd: string): TParts => tParts(new Date(Date.parse(dayRange(ymd).from) + 12 * 3_600_000));
export const todayYmd = (now = new Date()) => tYmd(tParts(now));
/** Previous `n` working days strictly before `ymd` (Friday + official_holidays skipped), most recent first. */
export function prevWorkDays(ymd: string, n: number): string[] {
  const out: string[] = []; let t = Date.parse(dayRange(ymd).from) + 12 * 3_600_000;
  for (let i = 0; i < 60 && out.length < n; i++) { t -= 86_400_000; const p = tParts(new Date(t)); if (isWorkDay(p)) out.push(tYmd(p)); }
  return out;
}
export const isWorkYmd = (ymd: string) => isWorkDay(ymdParts(ymd));

/* ---------------- call lock ---------------- */
export type StartResult = { status: number; error?: string; callId?: number; tel?: string; pending?: { callId: number; customerId: number; customerName: string; at: string }; restricted?: boolean; reused?: boolean };
export function cqStartCall(user: CqUser, customerId: number, via: string, now = new Date()): StartResult {
  ensureCallQueueSchema();
  const f = cqFlags();
  if (!cqLockOn(user, f)) return { status: 404, error: "این بخش فعال نیست." };
  const c = queryRow<{ id: number; name: string | null; phone: string | null }>(`SELECT c.id,c.name,c.phone FROM customers c WHERE c.id=? AND ${cqOwnedCustomerSql()}`, [customerId, user.salespersonId ?? -1]);
  if (!c) return { status: 404, error: "این مشتری در پرونده‌های شما نیست." };
  if (!c.phone) return { status: 422, error: "شماره‌ی این مشتری ثبت نشده است." };
  const pend = cqPendingCall(user.id);
  if (pend && Number(pend.customer_id) !== customerId) {
    const pc = queryRow<{ name: string | null }>("SELECT name FROM customers WHERE id=?", [pend.customer_id]);
    return { status: 423, error: `اول گزارش تماس با ${pc?.name ?? "مشتری قبلی"} را ثبت کن؛ بعد تماس بعدی باز می‌شود.`,
      pending: { callId: Number(pend.id), customerId: Number(pend.customer_id), customerName: pc?.name ?? "", at: pend.link_issued_at } };
  }
  if (f.restrict_panel) {
    const r = cqRestriction(user, now);
    if (r.restricted && !r.overdueCustomerIds.includes(customerId))
      return { status: 423, restricted: true, error: `پنل محدود است (${r.overdue} پیگیری عقب‌افتاده). فقط به عقب‌افتاده‌ها می‌شود زنگ زد.` };
  }
  if (pend) return { status: 200, callId: Number(pend.id), tel: `tel:${c.phone}`, reused: true };
  const id = execute("INSERT INTO call_queue_calls(user_id,salesperson_id,customer_id,via,link_issued_at) VALUES(?,?,?,?,?)",
    [user.id, user.salespersonId ?? null, customerId, via.slice(0, 40), now.toISOString()]);
  return { status: 200, callId: id, tel: `tel:${c.phone}` };
}
/** First CRM return (focus / visibilitychange) after the link was issued. Later returns never move it. */
export function cqMarkReturned(user: CqUser, id: number, now = new Date()): boolean {
  if (!cqLockOn(user)) return false;
  return executeChanges("UPDATE call_queue_calls SET returned_at=? WHERE id=? AND user_id=? AND returned_at IS NULL AND report_saved_at IS NULL AND link_issued_at<=?",
    [now.toISOString(), id, user.id, new Date(now.getTime() - 3000).toISOString()]) > 0;
}
export function cqPendingView(user: CqUser, now = new Date()) {
  if (!cqLockOn(user)) return { enabled: false as const, pending: null };
  const p = cqPendingCall(user.id); if (!p) return { enabled: true as const, pending: null };
  const c = queryRow<any>("SELECT id,name,phone,priority,COALESCE(is_urgent,0) is_urgent FROM customers WHERE id=?", [p.customer_id]);
  const s = cqDisciplineSettings();
  const deadline = p.returned_at ? new Date(Date.parse(p.returned_at) + s.onTimeMin * 60_000) : new Date(Date.parse(p.link_issued_at) + s.onTimeCapMin * 60_000);
  return { enabled: true as const, pending: { callId: Number(p.id), customerId: Number(p.customer_id), customerName: c?.name ?? "", phone: c?.phone ?? null, priority: c?.priority ?? null,
    urgent: Number(c?.is_urgent) === 1, linkIssuedAt: p.link_issued_at, returnedAt: p.returned_at, onTimeUntil: deadline.toISOString(), late: now.getTime() > deadline.getTime() } };
}

/* ---------------- discipline (display only) ---------------- */
export type DayStat = { day: string; crmCalls: number; onTime: number; onTimePct: number | null; overdue: number; nocall: number; score: number; ok: boolean; reasons: string[] };
/** Snoozes of that day after which the expert did not call the customer within 15 minutes of the reopen. */
function nocallAfterSnooze(userId: number, from: string, to: string, now: Date): number {
  const ev = queryRows<{ customer_id: number; created_at: string; data_json: string | null }>("SELECT customer_id,created_at,data_json FROM call_queue_events WHERE kind='snooze' AND user_id=? AND created_at>=? AND created_at<?", [userId, from, to]);
  let n = 0;
  for (const e of ev) {
    let until = Date.parse(e.created_at) + 10 * 60_000; try { const d = JSON.parse(e.data_json ?? "{}"); if (d.until) until = Date.parse(d.until); } catch { /* default */ }
    const limit = until + 15 * 60_000; if (limit > now.getTime()) continue;
    if (!queryRow("SELECT 1 FROM call_logs WHERE customer_id=? AND created_by_user_id=? AND created_at>=? AND created_at<=?", [e.customer_id, userId, e.created_at, new Date(limit).toISOString()])) n++;
  }
  return n;
}
export function cqScore(onTimePct: number | null, overdue: number, nocall: number) {
  const s = cqDisciplineSettings();
  const share = onTimePct == null ? 1 : onTimePct / 100;
  const v = s.wReport * share + s.wOverdue * (1 - Math.min(overdue / s.restrictOverdue, 1)) - s.wNocall * nocall;
  return Math.max(0, Math.min(100, Math.round(v)));
}
export function cqDayStat(user: CqUser, ymd: string, now = new Date()): DayStat {
  const s = cqDisciplineSettings(); const { from, to } = dayRange(ymd);
  const rows = queryRows<{ link_issued_at: string; returned_at: string | null; report_saved_at: string | null; on_time: number | null }>(
    "SELECT link_issued_at,returned_at,report_saved_at,on_time FROM call_queue_calls WHERE user_id=? AND link_issued_at>=? AND link_issued_at<?", [user.id, from, to]);
  let counted = 0, onTime = 0;
  for (const r of rows) {
    if (r.report_saved_at) { counted++; if (r.on_time ?? (cqOnTime(r.link_issued_at, r.returned_at, r.report_saved_at) ? 1 : 0)) onTime++; continue; }
    // unreported: counts as late once its window has passed; still open → not counted yet
    const lim = r.returned_at ? Date.parse(r.returned_at) + s.onTimeMin * 60_000 : Date.parse(r.link_issued_at) + s.onTimeCapMin * 60_000;
    if (now.getTime() > lim) counted++;
  }
  const pct = counted ? Math.round((onTime / counted) * 100) : null;
  const overdue = cqDue(user, now).total + dpOverdueExtra(user, now).length;
  const nocall = nocallAfterSnooze(user.id, from, to, now);
  const reasons: string[] = [];
  if (pct != null && pct <= s.newPct) reasons.push(`به‌موقع ${pct}٪ (باید بالای ${s.newPct}٪)`);
  if (overdue >= s.newMaxOverdue) reasons.push(`${overdue} پیگیری عقب‌افتاده (باید کمتر از ${s.newMaxOverdue})`);
  return { day: ymd, crmCalls: rows.length, onTime, onTimePct: pct, overdue, nocall, score: cqScore(pct, overdue, nocall), ok: reasons.length === 0, reasons };
}
export function cqRestriction(user: CqUser, now = new Date()) {
  const s = cqDisciplineSettings(); const d = cqDue(user, now); const extra = dpOverdueExtra(user, now); const total = d.total + extra.length;
  const ids = [...new Set([...d.items, ...d.snoozed].map(r => r.customerId).concat(extra))];
  return { restricted: total > s.restrictOverdue, overdue: total, threshold: s.restrictOverdue, leftToUnlock: Math.max(0, total - s.restrictOverdue), overdueCustomerIds: ids };
}
export function cqStreak(userId: number, todayOk: boolean | null, days: number, ymd: string): number {
  let n = todayOk === false ? 1 : 0; if (todayOk === true) return 0;
  for (const d of prevWorkDays(ymd, 15)) { const r = queryRow<{ ok: number }>("SELECT ok FROM call_queue_daily WHERE day=? AND user_id=?", [d, userId]); if (!r || r.ok) break; n++; if (n >= days + 10) break; }
  return n;
}
export function cqMyDiscipline(user: CqUser, now = new Date()) {
  const f = cqFlags(); if (!f.discipline || !cqEligible(user)) return { enabled: false as const };
  const ymd = todayYmd(now); const s = cqDisciplineSettings();
  const today = cqDayStat(user, ymd, now);
  const history = queryRows<any>("SELECT day,crm_calls crmCalls,on_time onTime,on_time_pct onTimePct,overdue,nocall,score,ok FROM call_queue_daily WHERE user_id=? ORDER BY day DESC LIMIT 10", [user.id])
    .map(r => ({ ...r, ok: Boolean(r.ok) }));
  const streak = isWorkYmd(ymd) ? cqStreak(user.id, today.ok, s.alertDays, ymd) : cqStreak(user.id, null, s.alertDays, ymd);
  return { enabled: true as const, today, history, streak, alertDays: s.alertDays, settings: { newPct: s.newPct, newMaxOverdue: s.newMaxOverdue, restrictOverdue: s.restrictOverdue, onTimeMin: s.onTimeMin, onTimeCapMin: s.onTimeCapMin },
    restriction: f.restrict_panel ? cqRestriction(user, now) : null, note: "فقط برای دیدن نظم پیگیری است؛ هیچ اثری روی حقوق یا پورسانت ندارد." };
}
/** Active eligible experts (generic: role salesperson + salesperson id; never 29 / trainees). */
export function cqEligibleUsers(): (CqUser & { name: string })[] {
  return queryRows<any>("SELECT u.id,u.role,u.salesperson_id salespersonId,u.active,COALESCE(u.full_name,u.username) name FROM users u WHERE u.active=1 AND u.role='salesperson' ORDER BY u.id")
    .map(r => ({ id: Number(r.id), role: r.role, salespersonId: r.salespersonId == null ? null : Number(r.salespersonId), active: Boolean(r.active), name: r.name ?? "" }))
    .filter(u => cqEligible(u) && !CQ_EXCLUDED_USER_IDS.includes(u.id));
}
export function cqTeamDiscipline(now = new Date()) {
  const f = cqFlags(); if (!f.discipline) return { enabled: false as const, experts: [] };
  const ymd = todayYmd(now); const s = cqDisciplineSettings();
  const experts = cqEligibleUsers().map(u => {
    const t = cqDayStat(u, ymd, now);
    return { userId: u.id, salespersonId: u.salespersonId, name: u.name, today: t, streak: cqStreak(u.id, isWorkYmd(ymd) ? t.ok : null, s.alertDays, ymd),
      restricted: f.restrict_panel ? t.overdue > s.restrictOverdue : false };
  });
  return { enabled: true as const, day: ymd, experts, settings: s, note: "فقط نمایش؛ هیچ اثری روی حقوق یا پورسانت ندارد." };
}

/* ---------------- daily snapshot + 3-workday alerts (job) ---------------- */
export function cqSnapshot(ymd: string, now = new Date()): number {
  let n = 0; const at = now.toISOString();
  for (const u of cqEligibleUsers()) {
    const t = cqDayStat(u, ymd, now);
    execute(`INSERT INTO call_queue_daily(day,user_id,salesperson_id,crm_calls,on_time,on_time_pct,overdue,nocall,score,ok,computed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(day,user_id) DO UPDATE SET crm_calls=excluded.crm_calls,on_time=excluded.on_time,on_time_pct=excluded.on_time_pct,overdue=excluded.overdue,
      nocall=excluded.nocall,score=excluded.score,ok=excluded.ok,computed_at=excluded.computed_at`,
      [ymd, u.id, u.salespersonId, t.crmCalls, t.onTime, t.onTimePct, t.overdue, t.nocall, t.score, t.ok ? 1 : 0, at]);
    n++;
  }
  return n;
}
function bell(kind: string, resourceType: string, resourceId: number, ownerSp: number | null, title: string, body: string, recipient: number, at: string) {
  execute(`INSERT INTO site_notification_events(customer_id,customer_name,owner_id,resource_type,resource_id,kind,title,body,permission,created_at,actor_key,recipient_user_id)
    VALUES(0,'',?,?,?,?,?,?,'customers.view',?,'call-queue:system',?)`, [ownerSp, resourceType, resourceId, kind, title, body, at, recipient]);
}
/** Once per streak: after an alert, the next one needs an ok day first. CRM bell only (managers + the expert's guiding version). */
export function cqRunAlerts(ymd: string, now = new Date()): number {
  const s = cqDisciplineSettings(); const at = now.toISOString(); let sent = 0;
  const hasCol = (crmDb.prepare("PRAGMA table_info(site_notification_events)").all() as { name: string }[]).some(c => c.name === "recipient_user_id");
  if (!hasCol) return 0;
  for (const u of cqEligibleUsers()) {
    const row = queryRow<{ ok: number; on_time_pct: number | null; overdue: number }>("SELECT ok,on_time_pct,overdue FROM call_queue_daily WHERE day=? AND user_id=?", [ymd, u.id]);
    if (!row || row.ok) continue;
    const streak = cqStreak(u.id, false, s.alertDays, ymd); if (streak < s.alertDays) continue;
    const last = queryRow<{ created_at: string; data_json: string }>("SELECT created_at,data_json FROM call_queue_events WHERE kind='alert_3days' AND user_id=? ORDER BY id DESC LIMIT 1", [u.id]);
    if (last) { let lastDay = ""; try { lastDay = JSON.parse(last.data_json).day; } catch { /* none */ }
      if (!queryRow("SELECT 1 FROM call_queue_daily WHERE user_id=? AND day>? AND day<=? AND ok=1", [u.id, lastDay, ymd])) continue; }
    const why = [row.on_time_pct != null && row.on_time_pct <= s.newPct ? `به‌موقع ${row.on_time_pct}٪` : null, row.overdue >= s.newMaxOverdue ? `${row.overdue} عقب‌افتاده` : null].filter(Boolean).join(" · ");
    for (const m of cqManagerIds()) bell("cq-discipline-3d", "cq-discipline", u.id, u.salespersonId, `${u.name}: ${streak} روز کاری پیاپی زیر حد`, `${why}. فقط CRM؛ برای کارشناس پیام راهنما رفت.`, m, at);
    bell("cq-discipline-3d-me", "cq-discipline-me", u.id, u.salespersonId, `${streak} روز کاری پیاپی زیر حد نظم پیگیری`,
      `${why}. برای برگشتن: عقب‌افتاده‌ها را از «صف تماس من» ببند و گزارش هر تماس را تا ${s.onTimeMin} دقیقه بعد ثبت کن.`, u.id, at);
    cqEvent("alert_3days", { userId: u.id, salespersonId: u.salespersonId, data: { day: ymd, streak, why }, at });
    sent++;
  }
  return sent;
}
let jobStarted = false;
/** Every 10 min: on a working day after 18:00 Tehran, snapshot today (flag.discipline) then alerts (flag.alerts). OFF = nothing written. */
export function startCallQueueJobs(): void {
  if (jobStarted) return; jobStarted = true;
  const tick = () => {
    try {
      const now = new Date(); const p = tParts(now); const f = cqFlags();
      if (!f.discipline || !isWorkDay(p) || p.h * 60 + p.mi < 18 * 60) return;
      const ymd = tYmd(p);
      if (queryRow("SELECT 1 FROM call_queue_daily WHERE day=? LIMIT 1", [ymd])) return;
      cqSnapshot(ymd, now);
      if (f.alerts) cqRunAlerts(ymd, now);
    } catch { /* never break the server */ }
  };
  // CQ_JOB_TICK_MS is only set by the offline test kit; production uses 10 minutes.
  const ms = Math.max(1000, Number(process.env.CQ_JOB_TICK_MS) || 10 * 60_000);
  const h = setInterval(tick, ms); h.unref?.();
}

/* ---------------- §8-33 daily digest signals (managers/admins, no individual notification) ---------------- */
export function cqSignals(dateIn: unknown, now = new Date()) {
  const f = cqFlags(); if (!f.signals) return { enabled: false as const, items: [] };
  const s = cqDisciplineSettings();
  let ymd = typeof dateIn === "string" && /^\d{4}-\d{2}-\d{2}$/.test(dateIn) ? dateIn : prevWorkDays(todayYmd(now), 1)[0];
  const work = isWorkYmd(ymd);
  const { from, to } = dayRange(ymd);
  const users = cqEligibleUsers(); const byId = new Map(users.map(u => [u.id, u]));
  const items: any[] = [];
  for (const e of queryRows<any>(`SELECT e.user_id,e.customer_id,e.call_id,e.reason,e.created_at,c.name customer_name FROM call_queue_events e LEFT JOIN customers c ON c.id=e.customer_id
      WHERE e.kind='signal_manual_no_crm' AND e.created_at>=? AND e.created_at<? ORDER BY e.created_at`, [from, to])) {
    const u = byId.get(Number(e.user_id)); if (!u) continue;
    items.push({ kind: "signal_manual_no_crm", userId: u.id, salespersonId: u.salespersonId, name: u.name, customerId: e.customer_id, customerName: e.customer_name ?? "",
      callId: e.call_id, manualType: e.reason, at: e.created_at, text: `ثبت دستی (${e.reason === "bale" ? "بله" : e.reason === "in_person" ? "حضوری" : "—"}) بدون تماس CRM همان روز` });
  }
  if (work) {
    const prev = prevWorkDays(ymd, 5);
    for (const u of users) {
      const cnt = (d: string) => { const r = dayRange(d); return Number(queryRow<{ n: number }>("SELECT COUNT(*) n FROM call_queue_calls WHERE user_id=? AND link_issued_at>=? AND link_issued_at<?", [u.id, r.from, r.to])?.n ?? 0); };
      const today = cnt(ymd); const avg = prev.length ? prev.map(cnt).reduce((a, b) => a + b, 0) / prev.length : 0;
      if (avg > 0 && today < avg * (1 - s.dropPct / 100))
        items.push({ kind: "signal_crm_drop", userId: u.id, salespersonId: u.salespersonId, name: u.name, count: today, avg5: Math.round(avg * 10) / 10,
          dropPct: Math.round((1 - today / avg) * 100), text: `تماس‌های CRM ${today} در برابر میانگین ${Math.round(avg * 10) / 10} پنج روز کاری قبل` });
    }
  }
  return { enabled: true as const, date: ymd, workday: work, dropPct: s.dropPct, items, note: "فقط در گزارش روزانه‌ی مدیر؛ اعلان فردی ندارد." };
}
