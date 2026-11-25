/**
 * «مدیریت فروش» — ویرایش ربات بله‌ی کارشناس‌ها (flag.smc_bot_edit_v1, global, default OFF).
 *
 * OFF → every /sales-admin/bots* route falls through / 404s, /sales-admin/me omits `botEdit`, nothing is read or written.
 * ON (with flag.sales_manager_console_v1=1): admin / sales_manager (never user 29) can list every expert's Bale bot
 * (including Ghasemi's redirect-only bot), edit bot name / status / mode / AI, test or replace the sealed token
 * (write-only masked field, never returned/logged), or disconnect.
 *
 * Red lines:
 *   - Never return, log, or store plaintext/ciphertext tokens in responses, URLs, logs, or smc_audit.
 *   - Never touch Bale personal-account tables (bale_accounts/bale_outbox/bale_messages), sidecar, team_sales_config,
 *     notification_settings, contracts, or user 29.
 *   - Never change Hasani's view-only scope (bale_view_as) or open sends on Ghasemi's redirect-only bot.
 */
import type { AuthUser } from "./auth";
import { execute, executeChanges, queryRow, queryRows, runImmediateTransaction } from "./crm-db";
import { fa, SMC_NEVER_USER, smcCanManage, smcFlagOn } from "./sales-manager-console";
import {
  BB_EXTRA_EXPERT_USER_IDS, baleCall, bbLog, bbNoSendSp, bbUser, bbUserOn, botOfUser, botToken,
  ensureBaleBotSchema, isBotExpert, nameOf, redact, tokenShapeOk, type BbUser,
} from "./bale-bot";
type BotRow = NonNullable<ReturnType<typeof botOfUser>>;
import { BC_GHASEMI_USER_ID } from "./bale-contact";
import { baleBotAad, baleBotHasKey, sealBotToken } from "./bale-bot-crypto";
import { K, sabAiFor, sabModeOf, sabOn } from "./sales-admin-bale";
import { shIsReadonlyBotUser } from "./social-hub-send";

export const SMC_BOT_EDIT_FLAG = "flag.smc_bot_edit_v1";

const setting = (k: string): string | null => {
  try {
    return queryRow<{ value: string }>("SELECT value FROM call_queue_settings WHERE key=?", [k])?.value ?? null;
  } catch {
    return null;
  }
};

export const smcBotEditFlagOn = () => setting(SMC_BOT_EDIT_FLAG) === "1";
export const smcBotEditOn = () => smcFlagOn() && smcBotEditFlagOn();
export const smcBotEditCanManage = (u: AuthUser | null | undefined) =>
  smcBotEditOn() && smcCanManage(u) && Number(u?.id) !== SMC_NEVER_USER;

type Fail = { ok: false; status: number; error: string; message: string };
const bad = (message: string, status = 422, error = "invalid"): Fail => ({ ok: false, status, error, message });

function readonlySendFor(u: { id: number; salesperson_id: number | null }): boolean {
  if (Number(u.id) === BC_GHASEMI_USER_ID) return true;
  if (u.salesperson_id != null && bbNoSendSp().includes(Number(u.salesperson_id))) return true;
  try {
    return shIsReadonlyBotUser(u.id);
  } catch {
    return false;
  }
}

function listCandidateUsers(): BbUser[] {
  const rows = queryRows<BbUser>(
    `SELECT u.id, u.role, u.role AS base_role, u.salesperson_id, u.active, u.full_name, u.username
     FROM users u
     LEFT JOIN bale_bots b ON b.user_id = u.id
     WHERE u.active = 1 AND u.id <> ?
       AND (u.role = 'salesperson' OR u.id IN (${BB_EXTRA_EXPERT_USER_IDS.map(Number).join(",") || "-1"}) OR b.id IS NOT NULL)
     ORDER BY u.id`,
    [SMC_NEVER_USER],
  );
  return rows.filter((u) => {
    if (u.id === SMC_NEVER_USER || u.active === 0) return false;
    if (isBotExpert(u)) return true;
    return !!botOfUser(u.id);
  });
}

function isEditableExpert(userId: number): BbUser | null {
  if (!Number.isInteger(userId) || userId <= 0 || userId === SMC_NEVER_USER) return null;
  const u = bbUser(userId);
  if (!u || u.active === 0 || u.id === SMC_NEVER_USER) return null;
  if (isBotExpert(u)) return u;
  return botOfUser(userId) ? u : null;
}

export type SmcExpertBotView = {
  userId: number;
  name: string;
  salespersonId: number | null;
  baleFlagOn: boolean;
  readonlySend: boolean;
  readonlyReason: string | null;
  mode: "own" | "shared";
  paused: boolean;
  bot: {
    id: number;
    name: string | null;
    username: string | null;
    botUserId: string | null;
    status: "on" | "off" | "err";
    tokenSaved: boolean;
    tokenStatusLabel: "ثبت شده" | "ثبت نشده";
    ai: boolean;
    connectedAt: string | null;
    lastOkAt: string | null;
    lastError: string | null;
  } | null;
};

function toExpertView(u: BbUser, b: BotRow | null): SmcExpertBotView {
  const ro = readonlySendFor(u);
  const mode: "own" | "shared" = ro ? "own" : sabModeOf(u.id);
  const hasTok = Boolean(b?.token_ct);
  return {
    userId: u.id,
    name: nameOf(u) ?? `کاربر ${u.id}`,
    salespersonId: u.salesperson_id == null ? null : Number(u.salesperson_id),
    baleFlagOn: bbUserOn(u.id),
    readonlySend: ro,
    readonlyReason: ro ? "فقط پیام انتقال · ارسال عادی و خودکار بسته است" : null,
    mode,
    paused: !ro && sabOn() && mode === "shared" && hasTok,
    bot: b
      ? {
          id: b.id,
          name: b.bot_name ?? null,
          username: b.bot_username ?? null,
          botUserId: b.bot_user_id ?? null,
          status: b.status,
          tokenSaved: hasTok,
          tokenStatusLabel: hasTok ? "ثبت شده" : "ثبت نشده",
          ai: sabAiFor(b.id),
          connectedAt: b.connected_at ?? null,
          lastOkAt: b.last_ok_at ?? null,
          lastError: b.last_error ?? null,
        }
      : null,
  };
}

export function smcBotsView() {
  ensureBaleBotSchema();
  const experts = listCandidateUsers().map((u) => toExpertView(u, botOfUser(u.id)));
  return {
    flag: SMC_BOT_EDIT_FLAG,
    hasKey: baleBotHasKey(process.env),
    sabEnabled: sabOn(),
    experts,
  };
}

async function getMe(token: string) {
  const r = await baleCall<{ id: number; first_name?: string; username?: string; is_bot?: boolean }>(token, "getMe", {}, 15_000);
  if (r.ok && r.result?.id != null) {
    return {
      ok: true as const,
      bot: {
        id: String(r.result.id),
        name: r.result.first_name ?? null,
        username: r.result.username ?? null,
      },
    };
  }
  const err = r.ok ? "bad_token" : r.network ? "network" : r.code === 401 || r.code === 404 ? "bad_token" : "bale_error";
  return { ok: false as const, error: err };
}

export async function smcBotTestToken(u: AuthUser, body: { token?: unknown }) {
  if (!smcBotEditCanManage(u)) return bad("این بخش فقط برای مدیر فروش و ادمین است.", 403, "smc_forbidden");
  const token = typeof body.token === "string" ? body.token.trim() : "";
  if (!tokenShapeOk(token)) {
    bbLog({ userId: u.id, action: "smc.bot.test", outcome: "bad_shape" });
    return bad("بله این توکن را نشناخت. توکن را دوباره از @botfather کپی کنید.", 400, "bad_token");
  }
  const g = await getMe(token);
  bbLog({ userId: u.id, action: "smc.bot.test", outcome: g.ok ? "ok" : g.error });
  if (!g.ok) {
    return bad(
      g.error === "network" ? "به بله وصل نشد. کمی بعد دوباره تست کنید." : "بله این توکن را نشناخت.",
      g.error === "network" ? 502 : 400,
      g.error,
    );
  }
  return { ok: true as const, bot: { name: g.bot.name, username: g.bot.username } };
}

export async function smcBotTestSaved(u: AuthUser, userId: number, now = new Date()) {
  if (!smcBotEditCanManage(u)) return bad("این بخش فقط برای مدیر فروش و ادمین است.", 403, "smc_forbidden");
  ensureBaleBotSchema();
  const target = isEditableExpert(userId);
  if (!target) return bad("کارشناس پیدا نشد.", 404, "unknown_expert");
  const b = botOfUser(userId);
  if (!b || !b.token_ct) return bad("برای این کارشناس هنوز توکنی ثبت نشده است.", 404, "not_found");
  const tok = botToken(b);
  if (!tok) return bad("کلید رمزنگاری توکن روی سرور نیست.", 503, "key_missing");
  const g = await getMe(tok);
  bbLog({ userId: u.id, botId: b.id, action: "smc.bot.test_saved", outcome: g.ok ? "ok" : g.error });
  const at = now.toISOString();
  if (!g.ok) {
    if (g.error === "bad_token") {
      executeChanges("UPDATE bale_bots SET status='err', last_error='token_rejected', updated_at=? WHERE id=?", [at, b.id]);
    }
    return bad(
      g.error === "network" ? "به بله وصل نشد. کمی بعد دوباره تست کنید." : "توکن ذخیره‌شده توسط بله رد شد.",
      g.error === "network" ? 502 : 400,
      g.error,
    );
  }
  executeChanges(
    "UPDATE bale_bots SET status=CASE WHEN status='err' THEN 'on' ELSE status END, last_error=NULL, last_ok_at=?, updated_at=? WHERE id=?",
    [at, at, b.id],
  );
  return { ok: true as const, bot: { name: g.bot.name, username: g.bot.username }, expert: toExpertView(target, botOfUser(userId)) };
}

const snapKeys = (keys: string[]) => Object.fromEntries(keys.map((k) => [k, setting(k)]));
function putKeys(next: Record<string, string | null>, uid: number, at: string): number {
  let n = 0;
  for (const [k, v] of Object.entries(next)) {
    const cur = setting(k);
    if (cur === v) continue;
    n++;
    if (v == null) execute("DELETE FROM call_queue_settings WHERE key=?", [k]);
    else {
      execute(
        "INSERT INTO call_queue_settings(key,value,updated_by,updated_at) VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_by=excluded.updated_by, updated_at=excluded.updated_at",
        [k, v, uid, at],
      );
    }
    execute("INSERT INTO call_queue_settings_log(key,old_value,new_value,user_id,at) VALUES(?,?,?,?,?)", [k, cur, v, uid, at]);
  }
  return n;
}

export type SmcBotEditInput = {
  botName?: unknown;
  status?: unknown;
  mode?: unknown;
  ai?: unknown;
  token?: unknown;
};

export async function smcBotEditSave(u: AuthUser, userId: number, body: SmcBotEditInput, now = new Date()) {
  if (!smcBotEditCanManage(u)) return bad("این بخش فقط برای مدیر فروش و ادمین است.", 403, "smc_forbidden");
  ensureBaleBotSchema();
  const target = isEditableExpert(userId);
  if (!target) return bad("کارشناس پیدا نشد.", 404, "unknown_expert");
  const ro = readonlySendFor(target);
  const cur = botOfUser(userId);

  let nextName: string | undefined;
  if (body.botName !== undefined) {
    if (typeof body.botName !== "string") return bad("نام ربات معتبر نیست.", 422, "invalid_name");
    const trimmed = body.botName.trim();
    if (!trimmed) return bad("نام ربات نمی‌تواند خالی باشد.", 422, "invalid_name");
    if (trimmed.length > 80) return bad("نام ربات نباید بیش از ۸۰ نویسه باشد.", 422, "invalid_name");
    nextName = trimmed;
  }

  let nextStatus: "on" | "off" | undefined;
  if (body.status !== undefined) {
    if (body.status !== "on" && body.status !== "off") return bad("وضعیت ربات باید فعال یا غیرفعال باشد.", 422, "invalid_status");
    nextStatus = body.status;
  }

  let nextMode: "own" | "shared" | undefined;
  if (body.mode !== undefined) {
    if (body.mode !== "own" && body.mode !== "shared") return bad("حالت پاسخگویی معتبر نیست.", 422, "invalid_mode");
    if (ro) return bad("ربات خانم قاسمی فقط برای پیام انتقال است و حالت آن تغییر نمی‌کند.", 403, "read_only");
    nextMode = body.mode;
  }

  let nextAi: boolean | undefined;
  if (body.ai !== undefined) {
    if (typeof body.ai !== "boolean") return bad("مقدار هوش مصنوعی معتبر نیست.", 422, "invalid_ai");
    if (ro) return bad("ربات خانم قاسمی فقط برای پیام انتقال است و هوش مصنوعی برای آن فعال نمی‌شود.", 403, "read_only");
    nextAi = body.ai;
  }

  const rawToken = typeof body.token === "string" ? body.token.trim() : "";
  const hasNewToken = rawToken.length > 0;
  if (body.token !== undefined && body.token !== null && typeof body.token !== "string") {
    return bad("توکن ربات معتبر نیست.", 400, "bad_token");
  }

  if (!hasNewToken && !cur?.token_ct) {
    if (nextStatus === "on" || nextName !== undefined || nextAi !== undefined || (!nextMode && !cur)) {
      return bad("برای این کارشناس هنوز رباتی وصل نشده است؛ ابتدا توکن ربات را وارد کنید.", 422, "no_token");
    }
  }

  let verifiedBot: { id: string; name: string | null; username: string | null } | null = null;
  if (hasNewToken) {
    if (!tokenShapeOk(rawToken)) {
      bbLog({ userId: u.id, botId: cur?.id ?? null, action: "smc.bot.edit", outcome: "bad_shape" });
      return bad("بله این توکن را نشناخت. توکن را دوباره از @botfather کپی کنید.", 400, "bad_token");
    }
    if (!baleBotHasKey(process.env)) return bad("کلید رمزنگاری توکن روی سرور نیست؛ توکن ذخیره نشد.", 503, "key_missing");
    const g = await getMe(rawToken);
    if (!g.ok) {
      bbLog({ userId: u.id, botId: cur?.id ?? null, action: "smc.bot.edit", outcome: g.error });
      return bad(
        g.error === "network" ? "به بله وصل نشد. کمی بعد دوباره تست کنید." : "بله این توکن را نشناخت.",
        g.error === "network" ? 502 : 400,
        g.error,
      );
    }
    if (queryRow("SELECT 1 FROM bale_bots WHERE bot_user_id=? AND user_id<>? AND token_ct IS NOT NULL", [g.bot.id, userId])) {
      return bad("این ربات برای کارشناس دیگری وصل است.", 409, "bot_in_use");
    }
    verifiedBot = g.bot;
  }

  const at = now.toISOString();
  const uid = Number(u.id);
  let botId = cur?.id ?? 0;
  let changed = false;
  let auditId = 0;

  runImmediateTransaction(() => {
    const beforeName = cur?.bot_name ?? null;
    const beforeStatus = cur?.status ?? null;
    const keyWrites: Record<string, string | null> = {};

    if (verifiedBot) {
      if (!botId) {
        botId = execute(
          "INSERT INTO bale_bots(user_id,status,created_by,created_at,updated_at) VALUES(?, 'off', ?, ?, ?)",
          [userId, uid, at, at],
        );
      }
      const sealed = sealBotToken(process.env, rawToken, baleBotAad(botId, userId));
      const sameBot = cur?.bot_user_id === verifiedBot.id;
      const resolvedName = nextName ?? verifiedBot.name ?? beforeName ?? null;
      const resolvedStatus = nextStatus ?? "on";
      executeChanges(
        `UPDATE bale_bots
         SET token_ct=?, token_key_id=?, bot_user_id=?, bot_username=?, bot_name=?, status=?,
             last_error=NULL, last_ok_at=?, updated_at=?,
             connected_at=CASE WHEN ? THEN COALESCE(connected_at,?) ELSE ? END,
             next_offset=CASE WHEN ? THEN next_offset ELSE 0 END,
             backlog_skipped=CASE WHEN ? THEN backlog_skipped ELSE 0 END
         WHERE id=?`,
        [
          sealed.value, sealed.keyId, verifiedBot.id, verifiedBot.username, resolvedName, resolvedStatus,
          at, at, sameBot ? 1 : 0, at, at, sameBot ? 1 : 0, sameBot ? 1 : 0, botId,
        ],
      );
      if (sabOn()) {
        if (!cur?.token_ct && nextAi === undefined && setting(K.ai(botId)) == null) keyWrites[K.ai(botId)] = "0";
        if (!ro && !cur?.token_ct && nextMode === undefined && setting(K.mode(userId)) == null) keyWrites[K.mode(userId)] = "own";
      }
      changed = true;
    } else if (cur && cur.token_ct) {
      const targetName = nextName !== undefined ? nextName : cur.bot_name;
      const targetStatus = nextStatus !== undefined ? nextStatus : cur.status;
      if (targetName !== cur.bot_name || targetStatus !== cur.status) {
        const clearErr = targetStatus === "on" && cur.status === "err";
        executeChanges(
          `UPDATE bale_bots SET bot_name=?, status=?, ${clearErr ? "last_error=NULL, " : ""}updated_at=? WHERE id=?`,
          [targetName, targetStatus, at, cur.id],
        );
        changed = true;
      }
    }

    if (sabOn() && !ro) {
      if (nextMode !== undefined) keyWrites[K.mode(userId)] = nextMode;
      if (nextAi !== undefined && botId > 0) keyWrites[K.ai(botId)] = nextAi ? "1" : "0";
    }

    const keys = Object.keys(keyWrites);
    const beforeKeys = keys.length ? snapKeys(keys) : undefined;
    const keyChanges = keys.length ? putKeys(keyWrites, uid, at) : 0;
    if (keyChanges > 0) changed = true;

    if (!changed) return;

    const afterBot = botId ? queryRow<BotRow>("SELECT * FROM bale_bots WHERE id=?", [botId]) : null;
    const parts: string[] = [];
    if (verifiedBot) parts.push(cur?.token_ct ? `تعویض توکن (@${verifiedBot.username ?? "—"})` : `اتصال ربات (@${verifiedBot.username ?? "—"})`);
    if (afterBot && beforeName !== afterBot.bot_name) parts.push(`نام «${afterBot.bot_name ?? "—"}»`);
    if (afterBot && beforeStatus !== afterBot.status) parts.push(`وضعیت ${afterBot.status === "on" ? "فعال" : "غیرفعال"}`);
    if (keyChanges > 0) parts.push(`${fa(keyChanges)} تنظیم پاسخگویی`);
    const summary = redact(`ویرایش ربات ${nameOf(target) ?? `کاربر ${userId}`}: ${parts.join("، ") || "به‌روزرسانی"}`, rawToken);

    auditId = execute(
      "INSERT INTO smc_audit(at,user_id,section,summary_fa,before_json,after_json) VALUES(?,?,?,?,?,?)",
      [
        at,
        uid,
        "bale_bots",
        summary,
        JSON.stringify({
          botEdit: {
            userId,
            botId: botId || null,
            botName: beforeName,
            status: beforeStatus,
            tokenChanged: Boolean(verifiedBot),
          },
          ...(beforeKeys ? { keys: beforeKeys } : {}),
        }),
        JSON.stringify({
          botEdit: {
            userId,
            botId: botId || null,
            botName: afterBot?.bot_name ?? null,
            status: afterBot?.status ?? null,
            username: afterBot?.bot_username ?? null,
            tokenChanged: Boolean(verifiedBot),
          },
          ...(keys.length ? { keys: snapKeys(keys) } : {}),
        }),
      ],
    );
  });

  if (changed) {
    bbLog({
      userId: uid,
      botId: botId || null,
      action: verifiedBot ? (cur?.token_ct ? "smc.bot.replace" : "smc.bot.connect") : "smc.bot.edit",
      outcome: "ok",
    });
  }

  return {
    ok: true as const,
    changed,
    auditId,
    expert: toExpertView(target, botOfUser(userId)),
  };
}

export function smcBotDisconnect(u: AuthUser, userId: number, now = new Date()) {
  if (!smcBotEditCanManage(u)) return bad("این بخش فقط برای مدیر فروش و ادمین است.", 403, "smc_forbidden");
  ensureBaleBotSchema();
  const target = isEditableExpert(userId);
  if (!target) return bad("کارشناس پیدا نشد.", 404, "unknown_expert");
  const cur = botOfUser(userId);
  if (!cur || !cur.token_ct) return bad("برای این کارشناس ربات وصلی ثبت نشده است.", 404, "not_found");
  const at = now.toISOString();
  const uid = Number(u.id);
  let auditId = 0;

  runImmediateTransaction(() => {
    executeChanges("UPDATE bale_bots SET status='off', token_ct=NULL, token_key_id=NULL, updated_at=? WHERE id=?", [at, cur.id]);
    auditId = execute(
      "INSERT INTO smc_audit(at,user_id,section,summary_fa,before_json,after_json) VALUES(?,?,?,?,?,?)",
      [
        at,
        uid,
        "bale_bots",
        `قطع اتصال ربات ${nameOf(target) ?? `کاربر ${userId}`} (@${cur.bot_username ?? "—"})`,
        JSON.stringify({ botEdit: { userId, botId: cur.id, botName: cur.bot_name, status: cur.status, tokenChanged: true } }),
        JSON.stringify({ botEdit: { userId, botId: cur.id, botName: cur.bot_name, status: "off", tokenChanged: true } }),
      ],
    );
  });

  bbLog({ userId: uid, botId: cur.id, action: "smc.bot.disconnect", outcome: "ok" });
  return {
    ok: true as const,
    changed: true,
    auditId,
    expert: toExpertView(target, botOfUser(userId)),
  };
}

/**
 * Reverts a non-token smc-bot-edit audit entry. Returns null when the audit row is not from smc-bot-edit
 * so existing sabUndo / samUndoFolded / revert handlers continue handling their own rows untouched.
 */
export function smcBotEditUndo(u: AuthUser, auditId: number, now = new Date()) {
  if (!smcBotEditCanManage(u)) return bad("این بخش فقط برای مدیر فروش و ادمین است.", 403, "smc_forbidden");
  const row = queryRow<{ id: number; section: string; before_json: string }>(
    "SELECT id, section, before_json FROM smc_audit WHERE id=?",
    [auditId],
  );
  if (!row || row.section !== "bale_bots") return null;
  let parsed: {
    botEdit?: { userId: number; botId: number | null; botName: string | null; status: string | null; tokenChanged?: boolean };
    keys?: Record<string, string | null>;
  };
  try {
    parsed = JSON.parse(row.before_json);
  } catch {
    return null;
  }
  if (!parsed?.botEdit) return null;
  if (parsed.botEdit.tokenChanged) {
    return bad("تغییر یا قطع توکن ربات از تاریخچه برگردانده نمی‌شود؛ در صورت نیاز توکن را دوباره وارد کنید.", 409, "not_revertible");
  }
  const be = parsed.botEdit;
  const at = now.toISOString();
  const uid = Number(u.id);
  const cur = be.botId ? queryRow<BotRow>("SELECT * FROM bale_bots WHERE id=?", [be.botId]) : null;
  if (be.status === "on" && (!cur || !cur.token_ct)) {
    return bad("برای برگرداندن وضعیت فعال، ابتدا باید توکن ربات ثبت باشد.", 409, "not_revertible");
  }
  const keys = parsed.keys ? Object.keys(parsed.keys) : [];
  const curKeys = keys.length ? snapKeys(keys) : undefined;
  let newAuditId = 0;

  runImmediateTransaction(() => {
    let changes = 0;
    if (cur && (cur.bot_name !== be.botName || (be.status && cur.status !== be.status))) {
      executeChanges("UPDATE bale_bots SET bot_name=?, status=?, updated_at=? WHERE id=?", [
        be.botName ?? cur.bot_name,
        (be.status === "on" || be.status === "off" || be.status === "err") ? be.status : cur.status,
        at,
        cur.id,
      ]);
      changes++;
    }
    if (keys.length && parsed.keys) {
      changes += putKeys(parsed.keys, uid, at);
    }
    if (changes > 0) {
      newAuditId = execute(
        "INSERT INTO smc_audit(at,user_id,section,summary_fa,before_json,after_json,revert_of) VALUES(?,?,?,?,?,?,?)",
        [
          at,
          uid,
          "bale_bots",
          `برگرداندن ویرایش ربات`,
          JSON.stringify({
            botEdit: { userId: be.userId, botId: be.botId, botName: cur?.bot_name ?? null, status: cur?.status ?? null, tokenChanged: false },
            ...(curKeys ? { keys: curKeys } : {}),
          }),
          JSON.stringify({
            botEdit: { userId: be.userId, botId: be.botId, botName: be.botName, status: be.status, tokenChanged: false },
            ...(keys.length ? { keys: snapKeys(keys) } : {}),
          }),
          auditId,
        ],
      );
    }
  });

  return { ok: true as const, changed: newAuditId > 0, auditId: newAuditId };
}
