/**
 * «مدیریت فروش» v1.3 — ربات‌های بله و پیام‌ها (#s-bale) + تبدیل تماس به متن (#s-voice). Design: nafis-design/mockups/sales-manager-console/bale-voice-v1.3.md,
 * Mohammad card t358s1326 (via Armita): AI on/off per bot; a canned message sends at once with one tap; recording default = save + auto-transcribe;
 * md defaults for §6 items 27, 28, 31, 33, 34.
 *
 * Flag: flag.sales_admin_bale_v13 (call_queue_settings, absent/≠'1' = OFF) AND the console flags (flag.sales_manager_console_v1 + flag.sales_admin_merge_v12).
 * OFF → every route here 404s, every hook returns the base (today's) answer, nothing is read or written.
 *
 * Writes (only through the routes, only by the sales manager / admin, never user 29) — all in call_queue_settings (+ call_queue_settings_log + smc_audit):
 *   sab.ai.bot.<bale_bots.id>        '1'|'0'  per-bot AI reply. Absent = today (follows the global AI switches); a bot connected here gets '0' (new bot off, §6-26).
 *   sab.bot_mode.user.<users.id>     'own'|'shared'. Absent = own when the expert has a token, else shared. 'shared' pauses the own bot (token kept, no poll/send).
 *   sab.bale_view.user.<users.id> / sab.bale_view.team.<sales_teams.id> / sab.bale_view.role.managers   'own'|'all'|'none'. Absent = today's view.
 *   sab.quick_messages               JSON [{id,title,body}] (≤12).
 *   sab.voice_mode                   'auto'|'manual'|'off'. Absent = 'auto' (t358s1326: save + auto-transcribe = today's live flag.call_transcripts.auto=1).
 *   sab.voice.pending                JSON [provider ids] — «تبدیل همه / انتخاب‌شده» backlog fed into the existing transcript queue as the system requester.
 * Bale bot connect (token): bale_bots row exactly like /bale-bot/admin/bots (sealed token, never returned/logged) + bale_bot_log (ids only) + smc_audit (no token).
 * OpenAI key: customer_bale_secrets via cbStoreSecret (same as CustomerBotKbAdmin); never returned, never logged, never in smc_audit.
 * Never: team_sales_config, notification_settings, sales_teams/members, loan_plans, contract text/templates, Bale session reconnects, any send in tests.
 */
import type { AuthUser } from "./auth";
import { execute, queryRow, queryRows, runImmediateTransaction } from "./crm-db";
import { fa, SMC_NEVER_USER, samMerged } from "./sales-manager-console";
import { samCanWriteFolded } from "./sales-admin-merge";
import {
  BB_EXTRA_EXPERT_USER_IDS, baleCall, bbLog, bbNoSendSp, bbUser, botOfUser, ensureBaleBotSchema, isBotExpert, nameOf, setBbViewHook, setBotPausedHook,
  tokenShapeOk, type BbUser,
} from "./bale-bot";
import { BC_GHASEMI_USER_ID, bcFlagOn } from "./bale-contact";
import { baleBotAad, baleBotHasKey, sealBotToken } from "./bale-bot-crypto";
import { cbAiLive, cbSecretMeta, cbSharedBot, cbSharedBotPublic, cbStoreSecret, ensureCustomerBaleSchema, setCbAiBotHook } from "./customer-bale";
import { aiEnabled } from "./ai-master";
import { setAutoCallReportsBlockHook } from "./automatic-call-reports";
import { callReportDay } from "./call-reports";
import { CALL_LIST_START } from "./call-list-cutoff";
import { SYSTEM_REQUESTER, lastFour } from "./call-transcripts";
import { ensureTranscriptSchema, queueTranscript } from "./recording-transcript-jobs";

export const SAB_FLAG = "flag.sales_admin_bale_v13";
const setting = (k: string): string | null => { try { return queryRow<{ value: string }>("SELECT value FROM call_queue_settings WHERE key=?", [k])?.value ?? null; } catch { return null; } };
export const sabFlagOn = () => setting(SAB_FLAG) === "1";
/** Needs the console flags too (t358s1326). */
export const sabOn = () => samMerged() && sabFlagOn();
/** Same people as the v1.2 folded-section writes: sales manager + admin (cqManager), never 29. */
export const sabCanWrite = (u: AuthUser | null | undefined) => sabOn() && samCanWriteFolded(u);

export const K = {
  ai: (botId: number) => `sab.ai.bot.${botId}`,
  mode: (userId: number) => `sab.bot_mode.user.${userId}`,
  viewUser: (userId: number) => `sab.bale_view.user.${userId}`,
  viewTeam: (teamId: number) => `sab.bale_view.team.${teamId}`,
  viewManagers: "sab.bale_view.role.managers",
  quick: "sab.quick_messages",
  voiceMode: "sab.voice_mode",
  voicePending: "sab.voice.pending",
} as const;

/* ---------------- effective values ---------------- */
export type ViewLevel = "own" | "all" | "none";
const isLevel = (v: unknown): v is ViewLevel => v === "own" || v === "all" || v === "none";
export type VoiceMode = "auto" | "manual" | "off";
const isVoice = (v: unknown): v is VoiceMode => v === "auto" || v === "manual" || v === "off";
export const sabVoiceMode = (): VoiceMode => { const v = setting(K.voiceMode); return isVoice(v) ? v : "auto"; };
/** Per-bot AI: '1'/'0' when set here; absent → true (today: the global AI switches decide). */
export const sabAiFor = (botId: number) => setting(K.ai(botId)) !== "0";
export function sabModeOf(userId: number): "own" | "shared" {
  const v = setting(K.mode(userId));
  if (v === "own" || v === "shared") return v;
  try { return botOfUser(userId)?.token_ct ? "own" : "shared"; } catch { return "shared"; }
}
const teamOfUser = (u: { salesperson_id: number | null }) => u.salesperson_id == null ? null
  : queryRow<{ team_id: number }>("SELECT m.team_id FROM sales_team_members m JOIN sales_teams t ON t.id=m.team_id WHERE m.salesperson_id=? AND t.enabled=1 ORDER BY m.team_id LIMIT 1", [u.salesperson_id])?.team_id ?? null;
/** user > team > managers row (admins / sales managers) > none (= today's view). */
export function sabViewLevel(u: BbUser): { level: ViewLevel | null; from: "user" | "team" | "managers" | null } {
  const own = setting(K.viewUser(u.id)); if (isLevel(own)) return { level: own, from: "user" };
  let team: number | null = null; try { team = teamOfUser(u); } catch { team = null; }
  if (team != null) { const t = setting(K.viewTeam(team)); if (isLevel(t)) return { level: t, from: "team" }; }
  if (u.role === "admin") { const m = setting(K.viewManagers); if (isLevel(m)) return { level: m, from: "managers" }; }
  return { level: null, from: null };
}

/* ---------------- hooks (installed at import; every one returns today's answer while the flag is OFF) ---------------- */
setBbViewHook((u, base) => {
  if (!sabOn()) return base;
  const { level } = sabViewLevel(u);
  if (level == null) return base;
  return level === "none" ? null : level; // §6-28: «هیچ» hides the inbox only; customer ownership is untouched
});
setBotPausedHook((b) => sabOn() && Number(b.user_id) !== 0 && setting(K.mode(Number(b.user_id))) === "shared");
setCbAiBotHook((b) => !sabOn() || sabAiFor(Number(b.id)));
setAutoCallReportsBlockHook(() => sabOn() && sabVoiceMode() !== "auto");

/* ---------------- generic settings write with history + undo ---------------- */
type Fail = { ok: false; status: number; error: string; message: string };
const bad = (message: string, status = 422, error = "invalid"): Fail => ({ ok: false, status, error, message });
export const SAB_SECTIONS = ["bale_bots", "bale_view", "bale_quick", "voice_mode", "voice_batch"] as const;
export type SabSection = typeof SAB_SECTIONS[number];
export const isSabSection = (s: unknown): s is SabSection => typeof s === "string" && (SAB_SECTIONS as readonly string[]).includes(s);
const snapKeys = (keys: string[]) => Object.fromEntries(keys.map((k) => [k, setting(k)]));
function putKeys(next: Record<string, string | null>, uid: number, at: string): number {
  let n = 0;
  for (const [k, v] of Object.entries(next)) {
    const cur = setting(k); if (cur === v) continue; n++;
    if (v == null) execute("DELETE FROM call_queue_settings WHERE key=?", [k]);
    else execute("INSERT INTO call_queue_settings(key,value,updated_by,updated_at) VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_by=excluded.updated_by, updated_at=excluded.updated_at", [k, v, uid, at]);
    execute("INSERT INTO call_queue_settings_log(key,old_value,new_value,user_id,at) VALUES(?,?,?,?,?)", [k, cur, v, uid, at]);
  }
  return n;
}
export type SabOk = { ok: true; changed: boolean; auditId: number };
function sabWrite(u: AuthUser, section: SabSection, next: Record<string, string | null>, summary: string, now = new Date()): SabOk | Fail {
  const at = now.toISOString(); const uid = Number(u.id);
  const keys = Object.keys(next); const before = snapKeys(keys);
  let n = 0; runImmediateTransaction(() => { n = putKeys(next, uid, at); });
  if (!n) return { ok: true, changed: false, auditId: 0 };
  const auditId = execute("INSERT INTO smc_audit(at,user_id,section,summary_fa,before_json,after_json) VALUES(?,?,?,?,?,?)",
    [at, uid, section, summary, JSON.stringify({ keys: before }), JSON.stringify({ keys: snapKeys(keys) })]);
  return { ok: true, changed: true, auditId };
}
/** «برگرداندن»: the same keys go back exactly (absent before → deleted) with call_queue_settings_log rows. A bot connect is not undone here. */
export function sabUndo(u: AuthUser, auditId: number, now = new Date()): SabOk | Fail {
  if (!sabCanWrite(u)) return bad("برگرداندن این بخش فقط برای مدیر فروش و ادمین است.", 403, "no_access");
  const a = queryRow<{ section: string; before_json: string }>("SELECT section, before_json FROM smc_audit WHERE id=?", [auditId]);
  if (!a || !isSabSection(a.section)) return bad("این تغییر پیدا نشد.", 404, "not_found");
  const b = JSON.parse(a.before_json) as { keys?: Record<string, string | null>; connect?: unknown };
  if (!b.keys || b.connect) return bad("وصل کردن ربات از اینجا برگردانده نمی‌شود.", 409, "not_revertible");
  const at = now.toISOString(); const uid = Number(u.id); const keys = Object.keys(b.keys); const cur = snapKeys(keys);
  let n = 0; runImmediateTransaction(() => { n = putKeys(b.keys!, uid, at); });
  if (!n) return { ok: true, changed: false, auditId: 0 };
  const id = execute("INSERT INTO smc_audit(at,user_id,section,summary_fa,before_json,after_json,revert_of) VALUES(?,?,?,?,?,?,?)",
    [at, uid, a.section, `برگرداندن (${fa(n)} مقدار)`, JSON.stringify({ keys: cur }), JSON.stringify({ keys: snapKeys(keys) }), auditId]);
  return { ok: true, changed: true, auditId: id };
}

/* ---------------- read models ---------------- */
type Person = { id: number; full_name: string | null; username: string; role: string; base_role: string; salesperson_id: number | null; active: number };
/** Experts in the connect/switch list: Bale-capable experts, never Ghasemi's read-only bot (bale_bot.no_send_sp / user 3), never 29. */
export function sabSwitchExperts(): Person[] {
  const noSend = bbNoSendSp();
  return queryRows<Person>(`SELECT id,role,role AS base_role,salesperson_id,active,full_name,username FROM users WHERE (role='salesperson' OR id IN (${BB_EXTRA_EXPERT_USER_IDS.map(Number).join(",") || "-1"})) AND active=1 ORDER BY id`)
    .filter((e) => isBotExpert(e as BbUser) && e.id !== BC_GHASEMI_USER_ID && e.id !== SMC_NEVER_USER && !noSend.includes(Number(e.salesperson_id)));
}
const shortName = (p: { full_name: string | null; username: string; id: number }) => nameOf(p) ?? `کاربر ${p.id}`;
export function sabBotsView() {
  ensureBaleBotSchema();
  let shared: ReturnType<typeof cbSharedBotPublic> = null;
  try { ensureCustomerBaleSchema(); shared = cbSharedBotPublic(cbSharedBot()); } catch { shared = null; }
  const experts = sabSwitchExperts().map((e) => {
    const b = botOfUser(e.id);
    const bot = b && b.token_ct ? { id: b.id, username: b.bot_username, name: b.bot_name, status: b.status, ai: sabAiFor(b.id) } : null;
    return { userId: e.id, name: shortName(e), mode: sabModeOf(e.id), bot, paused: !!bot && setting(K.mode(e.id)) === "shared" };
  });
  return {
    shared: shared ? { id: shared.id, name: shared.name, username: shared.username, status: shared.status, hasToken: shared.hasToken, ai: sabAiFor(shared.id) } : null,
    experts,
    contactFlow: { forced: bcFlagOn(), sharedOnly: true }, // §6-27: number sharing is forced on the shared bot only
    aiLive: cbAiLive(), aiMaster: aiEnabled(),
    canConnect: baleBotHasKey(process.env),
    openai: cbSecretMetaSafe(),
  };
}
const cbSecretMetaSafe = () => { try { ensureCustomerBaleSchema(); return cbSecretMeta("openai"); } catch { return { set: false, savedAt: null }; } };
export function sabViewModel() {
  const people = queryRows<Person>(`SELECT id,role,role AS base_role,salesperson_id,active,full_name,username FROM users WHERE active=1 AND id<>${SMC_NEVER_USER} ORDER BY id`);
  const enabledUser = (id: number) => setting(`flag.bale_bot.user.${id}`) === "1";
  const teams = queryRows<{ id: number; name: string }>("SELECT id,name FROM sales_teams WHERE enabled=1 ORDER BY id");
  const memberOf = new Map<number, number>();
  for (const r of queryRows<{ team_id: number; salesperson_id: number }>("SELECT m.team_id, m.salesperson_id FROM sales_team_members m JOIN sales_teams t ON t.id=m.team_id WHERE t.enabled=1 ORDER BY m.team_id"))
    if (!memberOf.has(Number(r.salesperson_id))) memberOf.set(Number(r.salesperson_id), Number(r.team_id));
  const row = (p: Person) => {
    const bu = bbUser(p.id)!; const lv = sabViewLevel(bu);
    const base = p.role === "admin" || p.base_role === "sales_manager" ? "all" : "own";
    return { userId: p.id, name: shortName(p), level: (setting(K.viewUser(p.id)) as ViewLevel | null) ?? null, effective: lv.level ?? base, from: lv.from, baleOn: enabledUser(p.id) };
  };
  const managers = people.filter((p) => p.role === "admin" || p.base_role === "sales_manager");
  const experts = people.filter((p) => !managers.includes(p) && (isBotExpert(bbUser(p.id) as BbUser) || enabledUser(p.id)));
  return {
    managers: { level: (setting(K.viewManagers) as ViewLevel | null) ?? "all", members: managers.map(row) },
    teams: teams.map((t) => ({ id: t.id, name: t.name, level: (setting(K.viewTeam(t.id)) as ViewLevel | null) ?? null,
      members: experts.filter((p) => p.salesperson_id != null && memberOf.get(Number(p.salesperson_id)) === t.id).map(row) })),
    others: experts.filter((p) => p.salesperson_id == null || !teams.some((t) => memberOf.get(Number(p.salesperson_id)) === t.id)).map(row),
  };
}
export type QuickMessage = { id: string; title: string; body: string };
export function sabQuickMessages(): QuickMessage[] {
  try { const a = JSON.parse(setting(K.quick) ?? "[]"); return Array.isArray(a) ? a.filter((q) => q && typeof q.id === "string" && typeof q.title === "string" && typeof q.body === "string") : []; } catch { return []; }
}

/* ---------------- voice: calls with audio and no successful text ---------------- */
type VRow = { id: number; provider_id: string; phone: string | null; direction: string; started_at: string; ended_at: string; duration_seconds: number | null; status: string;
  expert_user_id: number | null; expert_name: string | null; customer_name: string | null; recording_file: string; t_state: string | null; t_file: string | null };
const V_SQL = `SELECT e.id, COALESCE(e.recording_provider_id,e.external_id) provider_id, e.phone, e.direction, e.started_at, e.ended_at, e.duration_seconds, e.status,
  e.expert_user_id, COALESCE(eu.full_name,e.expert_name) expert_name, c.name customer_name, e.recording_file, t.state t_state, t.source_file t_file
  FROM voip_after_call_events e LEFT JOIN call_logs l ON l.id=e.call_log_id LEFT JOIN customers c ON c.id=COALESCE(l.customer_id,e.customer_id)
  LEFT JOIN users eu ON eu.id=e.expert_user_id
  LEFT JOIN voip_recording_transcripts t ON t.external_id=COALESCE(e.recording_provider_id,e.external_id)
  WHERE e.is_live=0 AND e.has_recording=1 AND e.recording_file IS NOT NULL AND COALESCE(e.recording_provider_id,e.external_id) NOT LIKE 'live-%'
    AND julianday(e.started_at) >= julianday(?) AND COALESCE(e.expert_user_id,0)<>${SMC_NEVER_USER}
    AND NOT (t.state='completed' AND t.source_file=e.recording_file)`;
/** §6-33: every recording without a successful text, failed ones included. */
export function sabUntranscribed(limit = 500): VRow[] {
  try { ensureTranscriptSchema(); } catch { /* table exists in prod */ }
  return queryRows<VRow>(`${V_SQL} ORDER BY e.started_at DESC LIMIT ?`, [new Date(CALL_LIST_START).toISOString(), limit]);
}
const pendingIds = (): string[] => { try { const a = JSON.parse(setting(K.voicePending) ?? "[]"); return Array.isArray(a) ? a.map(String) : []; } catch { return []; } };
/** Armita review (v1.3 shots 20): 20 rows a page; total and «تبدیل همه» still cover every page (the 10-in-flight cap stays in queueTranscript). */
export const SAB_VOICE_PER = 20;
export function sabVoiceView(pageIn: unknown = 1) {
  const pend = new Set(pendingIds());
  const all = sabUntranscribed(2000);
  const pages = Math.max(1, Math.ceil(all.length / SAB_VOICE_PER));
  const page = Math.min(pages, Math.max(1, Math.floor(Number(pageIn)) || 1));
  const rows = all.slice((page - 1) * SAB_VOICE_PER, page * SAB_VOICE_PER).map((r) => ({
    id: r.id, at: r.started_at, direction: r.direction === "in" || r.direction === "incoming" || r.direction === "inbound" ? "in" : "out",
    expert: r.expert_name ?? null, customer: r.customer_name ?? lastFour(r.phone),
    durationS: r.duration_seconds ?? Math.max(0, Math.round((Date.parse(r.ended_at) - Date.parse(r.started_at)) / 1000)),
    state: r.t_state === "queued" || r.t_state === "processing" ? r.t_state : pend.has(r.provider_id) ? "waiting" : r.t_state === "failed" ? "failed" : "none",
  }));
  return { mode: sabVoiceMode(), modeSet: setting(K.voiceMode) != null, total: all.length, pending: pend.size, page, pages, per: SAB_VOICE_PER, rows };
}

/* ---------------- writes ---------------- */
const need = (u: AuthUser): Fail | null => !sabOn() ? bad("این بخش هنوز روشن نیست.", 404, "not_found") : !sabCanWrite(u) ? bad("ذخیره‌ی این بخش فقط برای مدیر فروش و ادمین است.", 403, "no_access") : null;
const botRow = (id: number) => queryRow<{ id: number; user_id: number; token_ct: string | null; bot_username: string | null }>("SELECT id,user_id,token_ct,bot_username FROM bale_bots WHERE id=?", [id]);
/** Ghasemi's read-only bot (and any no-send bot) is never switchable here. */
const switchable = (userId: number) => sabSwitchExperts().some((e) => e.id === userId);

export function sabSetAi(u: AuthUser, body: { botId?: unknown; on?: unknown; all?: unknown }) {
  const f = need(u); if (f) return f;
  const on = body.on === true ? "1" : body.on === false ? "0" : null; if (on == null) return bad("روشن یا خاموش را انتخاب کنید.");
  const ids: number[] = [];
  if (body.all === true) {
    const s = cbSharedBot(); if (s?.token_ct) ids.push(Number(s.id));
    for (const e of sabSwitchExperts()) { const b = botOfUser(e.id); if (b?.token_ct) ids.push(b.id); }
  } else {
    const b = botRow(Number(body.botId)); if (!b) return bad("ربات پیدا نشد.", 404, "not_found");
    if (Number(b.user_id) !== 0 && !switchable(Number(b.user_id))) return bad("این ربات فقط‌خواندنی است.", 403, "read_only");
    ids.push(b.id);
  }
  const next = Object.fromEntries(ids.map((id) => [K.ai(id), on]));
  return sabWrite(u, "bale_bots", next, `پاسخ هوش مصنوعی ${on === "1" ? "روشن" : "خاموش"}: ${body.all === true ? "همه‌ی ربات‌ها" : `@${botRow(ids[0]!)?.bot_username ?? "ربات"}`}`);
}
export function sabSetMode(u: AuthUser, body: { userId?: unknown; mode?: unknown; all?: unknown }) {
  const f = need(u); if (f) return f;
  const mode = body.mode === "own" || body.mode === "shared" ? body.mode : null; if (!mode) return bad("ربات خودش یا ربات مشترک را انتخاب کنید.");
  const users = body.all === true ? sabSwitchExperts().map((e) => e.id) : [Number(body.userId)];
  if (!users.every(switchable)) return bad("این کارشناس در فهرست ربات‌ها نیست.", 403, "read_only");
  return sabWrite(u, "bale_bots", Object.fromEntries(users.map((id) => [K.mode(id), mode])),
    body.all === true ? `یکسان برای همه: ${mode === "shared" ? "ربات مشترک" : "ربات خودش"}` : `${shortName(bbUser(users[0]!)!)}: ${mode === "shared" ? "ربات مشترک" : "ربات خودش"}`);
}
export function sabSetView(u: AuthUser, body: { scope?: unknown; id?: unknown; level?: unknown; applyMembers?: unknown }) {
  const f = need(u); if (f) return f;
  const lv = body.level === null ? null : isLevel(body.level) ? body.level : undefined; if (lv === undefined) return bad("سطح دید نامعتبر است.");
  const id = Number(body.id);
  if (body.scope === "managers") return sabWrite(u, "bale_view", { [K.viewManagers]: lv }, `دید بله‌ی مدیر فروش و ادمین: ${LV_FA[lv ?? "all"]}`);
  if (body.scope === "team") {
    if (!queryRow("SELECT 1 FROM sales_teams WHERE id=? AND enabled=1", [id])) return bad("تیم پیدا نشد.", 404, "not_found");
    const next: Record<string, string | null> = { [K.viewTeam(id)]: lv };
    if (body.applyMembers === true) for (const m of sabViewModel().teams.find((t) => t.id === id)?.members ?? []) next[K.viewUser(m.userId)] = null; // «یکسان برای همه‌ی تیم»
    return sabWrite(u, "bale_view", next, `دید بله‌ی ${queryRow<{ name: string }>("SELECT name FROM sales_teams WHERE id=?", [id])?.name ?? "تیم"}: ${lv ? LV_FA[lv] : "پیش‌فرض"}${body.applyMembers === true ? " (همه‌ی اعضا)" : ""}`);
  }
  if (body.scope === "user") {
    if (!Number.isInteger(id) || id <= 0 || id === SMC_NEVER_USER || !queryRow("SELECT 1 FROM users WHERE id=? AND active=1", [id])) return bad("کاربر پیدا نشد.", 404, "not_found");
    return sabWrite(u, "bale_view", { [K.viewUser(id)]: lv }, `دید بله‌ی ${shortName(bbUser(id)!)}: ${lv ? LV_FA[lv] : "پیش‌فرض"}`);
  }
  return bad("دامنه نامعتبر است.");
}
const LV_FA: Record<ViewLevel, string> = { own: "فقط خودش", all: "همه", none: "هیچ" };
export function sabSaveQuick(u: AuthUser, body: { items?: unknown }) {
  const f = need(u); if (f) return f;
  if (!Array.isArray(body.items) || body.items.length > 12) return bad("حداکثر ۱۲ پیام پیش‌فرض.");
  const out: QuickMessage[] = []; const seen = new Set<string>();
  for (const it of body.items as any[]) {
    const title = String(it?.title ?? "").trim(); const text = String(it?.body ?? "").trim();
    if (!title || [...title].length > 40) return bad("عنوان پیام باید ۱ تا ۴۰ حرف باشد.");
    if (!text || [...text].length > 1000) return bad("متن پیام باید ۱ تا ۱۰۰۰ حرف باشد.");
    let id = typeof it?.id === "string" && /^q[a-z0-9]{1,16}$/.test(it.id) && !seen.has(it.id) ? it.id : "";
    if (!id) do { id = "q" + Math.random().toString(36).slice(2, 10); } while (seen.has(id));
    seen.add(id); out.push({ id, title, body: text });
  }
  const before = sabQuickMessages();
  return sabWrite(u, "bale_quick", { [K.quick]: out.length ? JSON.stringify(out) : null }, `پیام‌های پیش‌فرض: ${fa(before.length)} → ${fa(out.length)}`);
}
export function sabSetVoiceMode(u: AuthUser, body: { mode?: unknown }) {
  const f = need(u); if (f) return f;
  if (!isVoice(body.mode)) return bad("حالت ضبط و تبدیل نامعتبر است.");
  return sabWrite(u, "voice_mode", { [K.voiceMode]: body.mode }, `ضبط و تبدیل: ${VOICE_FA[body.mode]}`);
}
const VOICE_FA: Record<VoiceMode, string> = { auto: "ذخیره و تبدیل خودکار", manual: "فقط ذخیره؛ تبدیل دستی", off: "غیرفعال" };
/** «تبدیل انتخاب‌شده» / «تبدیل همه»: ids go to sab.voice.pending; the feeder moves them into the existing transcript queue as free slots open. */
export function sabRequestTranscripts(u: AuthUser, body: { ids?: unknown; all?: unknown }) {
  const f = need(u); if (f) return f;
  if (sabVoiceMode() === "off") return bad("تبدیل تماس غیرفعال است.", 409, "voice_off");
  const rows = sabUntranscribed(2000);
  const want = body.all === true ? rows : rows.filter((r) => Array.isArray(body.ids) && (body.ids as unknown[]).map(Number).includes(r.id));
  if (!want.length) return bad("تماسی انتخاب نشده است.");
  const cur = pendingIds(); const next = [...new Set([...cur, ...want.filter((r) => r.t_state !== "queued" && r.t_state !== "processing").map((r) => r.provider_id)])].slice(0, 2000);
  const w = sabWrite(u, "voice_batch", { [K.voicePending]: next.length ? JSON.stringify(next) : null }, `تبدیل ${body.all === true ? "همه" : "انتخاب‌شده"}: ${fa(want.length)} تماس`);
  if (!w.ok) return w;
  const fed = sabFeedVoice();
  return { ...w, requested: want.length, queuedNow: fed.queued };
}
/** Moves pending ids into voip_recording_transcripts through queueTranscript (its own limits: 10 in flight). Never calls a provider itself. */
export function sabFeedVoice(): { queued: number; left: number; error: string | null } {
  if (!sabOn()) return { queued: 0, left: 0, error: null };
  const ids = pendingIds(); if (!ids.length) return { queued: 0, left: 0, error: null };
  let queued = 0; let error: string | null = null; const left: string[] = [];
  for (const pid of ids) {
    if (error) { left.push(pid); continue; }
    const e = queryRow<{ recording_file: string | null; started_at: string; ended_at: string; t_state: string | null; t_file: string | null }>(
      `SELECT e.recording_file, e.started_at, e.ended_at, t.state t_state, t.source_file t_file FROM voip_after_call_events e
       LEFT JOIN voip_recording_transcripts t ON t.external_id=COALESCE(e.recording_provider_id,e.external_id)
       WHERE COALESCE(e.recording_provider_id,e.external_id)=? AND e.has_recording=1 ORDER BY e.id DESC LIMIT 1`, [pid]);
    if (!e?.recording_file || (e.t_state === "completed" && e.t_file === e.recording_file)) continue;
    try { queueTranscript(pid, e.recording_file, callReportDay(e.started_at), callReportDay(e.ended_at), SYSTEM_REQUESTER, true); queued++; }
    catch (x) { error = x instanceof Error ? x.message.slice(0, 120) : "queue_refused"; left.push(pid); }
  }
  execute("INSERT INTO call_queue_settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
    [K.voicePending, JSON.stringify(left), new Date().toISOString()]);
  if (!left.length) execute("DELETE FROM call_queue_settings WHERE key=?", [K.voicePending]);
  return { queued, left: left.length, error };
}

/** Bot connect from the section: same checks + sealing as POST /bale-bot/admin/bots, but never for Ghasemi, never a replace
 * (an expert who already has a token is refused: no session is reconnected from here). The token is never returned or logged. */
export async function sabConnectBot(u: AuthUser, body: { userId?: unknown; token?: unknown }, now = new Date()) {
  const f = need(u); if (f) return f;
  const userId = Number(body.userId); const token = String(body.token ?? "").trim();
  if (!switchable(userId)) return bad("این کارشناس در فهرست ربات‌ها نیست.", 403, "read_only");
  if (!tokenShapeOk(token)) return bad("بله این توکن را نشناخت. توکن را دوباره از @botfather کپی کنید.", 400, "bad_token");
  if (!baleBotHasKey(process.env)) return bad("کلید رمزنگاری توکن روی سرور نیست؛ توکن ذخیره نشد.", 503, "key_missing");
  ensureBaleBotSchema();
  const cur = botOfUser(userId); if (cur?.token_ct) return bad("این کارشناس ربات وصل دارد.", 409, "has_bot");
  const g = await baleCall<{ id: number; first_name?: string; username?: string }>(token, "getMe", {}, 15_000);
  if (!g.ok) { bbLog({ userId: u.id, action: "sab.connect", outcome: g.network ? "network" : "bad_token" }); return bad(g.network ? "به بله وصل نشد. کمی بعد دوباره تست کنید." : "بله این توکن را نشناخت.", g.network ? 502 : 400, g.network ? "network" : "bad_token"); }
  const botUserId = String(g.result.id);
  if (queryRow("SELECT 1 FROM bale_bots WHERE bot_user_id=? AND user_id<>? AND token_ct IS NOT NULL", [botUserId, userId])) return bad("این ربات برای کارشناس دیگری وصل است.", 409, "bot_in_use");
  const at = now.toISOString(); let id = cur?.id ?? 0;
  const aiBefore = id ? setting(K.ai(id)) : null; const modeBefore = setting(K.mode(userId));
  runImmediateTransaction(() => {
    if (!id) id = execute("INSERT INTO bale_bots(user_id,status,created_by,created_at,updated_at) VALUES(?, 'off', ?, ?, ?)", [userId, u.id, at, at]);
    const sealed = sealBotToken(process.env, token, baleBotAad(id, userId));
    execute(`UPDATE bale_bots SET token_ct=?, token_key_id=?, bot_user_id=?, bot_username=?, bot_name=?, status='on', last_error=NULL, updated_at=?, connected_at=?, next_offset=0, backlog_skipped=0 WHERE id=?`,
      [sealed.value, sealed.keyId, botUserId, g.result.username ?? null, g.result.first_name ?? null, at, at, id]);
    putKeys({ [K.ai(id)]: "0", [K.mode(userId)]: "own" }, Number(u.id), at); // §6-26: a new bot starts with AI off
  });
  bbLog({ userId: u.id, botId: id, action: "sab.connect", outcome: "ok" });
  const auditId = execute("INSERT INTO smc_audit(at,user_id,section,summary_fa,before_json,after_json) VALUES(?,?,?,?,?,?)",
    [at, u.id, "bale_bots", `ربات ${shortName(bbUser(userId)!)} وصل شد (@${g.result.username ?? "—"})`,
      JSON.stringify({ connect: true, keys: { [K.ai(id)]: aiBefore, [K.mode(userId)]: modeBefore } }), JSON.stringify({ connect: true, botId: id, username: g.result.username ?? null })]);
  return { ok: true as const, changed: true, auditId, bot: { id, username: g.result.username ?? null, name: g.result.first_name ?? null } };
}
/** OpenAI key (§6-31: sales manager + admin may enter a new key). Stored like CustomerBotKbAdmin; the answer is only {set, savedAt}. */
export function sabSaveKey(u: AuthUser, body: { value?: unknown }, now = new Date()) {
  const f = need(u); if (f) return f;
  const v = typeof body.value === "string" ? body.value.trim() : "";
  if (v.length < 8 || v.length > 400 || /\s/.test(v)) return bad("کلید را کامل بچسبانید.", 400, "invalid");
  ensureCustomerBaleSchema(); cbStoreSecret("openai", v, now.toISOString());
  const auditId = execute("INSERT INTO smc_audit(at,user_id,section,summary_fa,before_json,after_json) VALUES(?,?,?,?,?,?)",
    [now.toISOString(), u.id, "bale_bots", "کلید OpenAI تازه ذخیره شد", JSON.stringify({ connect: true, secret: "openai" }), JSON.stringify({ secret: "openai", saved: true })]);
  return { ok: true as const, changed: true, auditId, openai: cbSecretMeta("openai") };
}

export function sabState() {
  return { bots: sabBotsView(), view: sabViewModel(), quick: sabQuickMessages(), voice: sabVoiceView(),
    writes: SAB_WRITES, flag: SAB_FLAG };
}
/** Exact tables/keys each part writes (shown to Mohammad; none is team_sales_config or notification_settings). */
export const SAB_WRITES = [
  { part: "ai", table: "call_queue_settings", keys: "sab.ai.bot.<bale_bots.id>" },
  { part: "mode", table: "call_queue_settings", keys: "sab.bot_mode.user.<users.id>" },
  { part: "connect", table: "bale_bots", keys: "one row (sealed token) + bale_bot_log (ids only)" },
  { part: "key", table: "customer_bale_secrets", keys: "kind=openai" },
  { part: "view", table: "call_queue_settings", keys: "sab.bale_view.user.<id> / .team.<id> / .role.managers" },
  { part: "quick", table: "call_queue_settings", keys: "sab.quick_messages" },
  { part: "voice", table: "call_queue_settings", keys: "sab.voice_mode, sab.voice.pending" },
  { part: "voice", table: "voip_recording_transcripts", keys: "queued rows via the existing queueTranscript (system requester)" },
  { part: "all", table: "call_queue_settings_log + smc_audit", keys: "one row per changed key / per save" },
] as const;

/** Feeds the «تبدیل همه» backlog every minute while ON (one settings read otherwise). SAB_FEEDER=0 disables it (fixtures). */
let feeder: ReturnType<typeof setInterval> | null = null;
export function startSabVoiceFeeder() {
  if (feeder || process.env.SAB_FEEDER === "0" || process.env.NODE_ENV === "test") return;
  feeder = setInterval(() => { try { if (sabOn()) sabFeedVoice(); } catch { /* next tick */ } }, 60_000);
  feeder.unref?.();
}
/** GET /bale-bot/admin → 301 /sales-admin#s-bale while ON (no-store so the redirect is not cached past a flag change). OFF → next(). */
export function sabBaleAdminRedirect(req: { method: string; path: string }, res: { status: (n: number) => any; setHeader: (k: string, v: string) => void; end: () => void }, next: () => void) {
  if ((req.method !== "GET" && req.method !== "HEAD") || !/^\/bale-bot\/admin\/?$/.test(req.path)) return next();
  let on = false; try { on = sabOn(); } catch { on = false; }
  if (!on) return next();
  res.setHeader("Location", "/sales-admin#s-bale"); res.setHeader("Cache-Control", "no-store"); res.status(301); res.end();
}
