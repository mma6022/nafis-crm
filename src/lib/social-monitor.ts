import { Router, type IRouter, type RequestHandler } from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import { crmDb, queryRows } from "./crm-db";
import { requireAdmin, requireAuth } from "./auth";
import { permissionsForRole } from "./access-control";
import { attachSocialThreads, socialThreadReport } from "./social-monitor-threads";

const SERVICES = new Set(["tg", "wa", "bale"]);
const MAX_BATCH = 30;
const MAX_TEXT = 5000;
const now = () => new Date().toISOString();
const dayInTehran = (value: string) => {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tehran", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tehran", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(date);
};

crmDb.exec(`
  CREATE TABLE IF NOT EXISTS social_monitor_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_user_id INTEGER NOT NULL,
    service TEXT NOT NULL CHECK(service IN ('tg','wa','bale')),
    conversation_key TEXT NOT NULL,
    contact_name TEXT NOT NULL,
    message_key TEXT NOT NULL,
    direction TEXT NOT NULL CHECK(direction IN ('inbound','outbound')),
    message_text TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    timestamp_known INTEGER NOT NULL DEFAULT 0,
    local_day TEXT NOT NULL,
    captured_at TEXT NOT NULL,
    UNIQUE(employee_user_id,service,conversation_key,message_key)
  );
  CREATE INDEX IF NOT EXISTS idx_social_monitor_day_user
    ON social_monitor_messages(local_day,employee_user_id,service);
  CREATE INDEX IF NOT EXISTS idx_social_monitor_conversation
    ON social_monitor_messages(employee_user_id,service,conversation_key,local_day,occurred_at);
  CREATE TABLE IF NOT EXISTS social_monitor_daily_summaries (
    employee_user_id INTEGER NOT NULL,
    local_day TEXT NOT NULL,
    conversation_count INTEGER NOT NULL,
    inbound_count INTEGER NOT NULL,
    outbound_count INTEGER NOT NULL,
    services_json TEXT NOT NULL,
    summary TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(employee_user_id,local_day)
  );
  CREATE TABLE IF NOT EXISTS social_monitor_capture_nonces (
    nonce TEXT PRIMARY KEY,
    used_at TEXT NOT NULL
  );
`);
if (!(crmDb.prepare("PRAGMA table_info(social_monitor_messages)").all() as Array<{ name: string }>).some(c => c.name === "timestamp_known")) {
  crmDb.exec("ALTER TABLE social_monitor_messages ADD COLUMN timestamp_known INTEGER NOT NULL DEFAULT 0");
}

function secret(): string {
  if (process.env.SOCIAL_SECRET) return process.env.SOCIAL_SECRET;
  const file = process.env.SOCIAL_SECRET_FILE || "/var/lib/nafisvam-social/secret";
  try { return fs.readFileSync(file, "utf8").trim(); }
  catch { throw new Error("Social capture signing secret is unavailable"); }
}

function signatureValid(req: Parameters<RequestHandler>[0]): { actorId: number; nonce: string } | null {
  const timestamp = String(req.header("x-social-timestamp") || "");
  const nonce = String(req.header("x-social-nonce") || "");
  const signature = String(req.header("x-social-signature") || "");
  if (!/^\d{10,13}$/.test(timestamp) || !/^[a-f0-9-]{24,64}$/i.test(nonce) || !/^[a-f0-9]{64}$/i.test(signature)) return null;
  const ts = Number(timestamp);
  if (Math.abs(Date.now() - ts) > 5 * 60_000) return null;
  const body = JSON.stringify(req.body);
  const expected = createHmac("sha256", secret()).update(`${timestamp}.${nonce}.${body}`).digest();
  const actual = Buffer.from(signature, "hex");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  const actorId = Number(req.body?.employeeId);
  return Number.isSafeInteger(actorId) && actorId > 0 ? { actorId, nonce } : null;
}

function isActiveCaptureUser(id: number): boolean {
  const user = crmDb.prepare("SELECT role,active FROM users WHERE id=?").get(id) as { role: string; active: number } | undefined;
  return !!user && !!user.active && (user.role === "admin" || permissionsForRole(user.role).includes("internal_chat.use"));
}

function validDay(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export function createSocialMonitorFeature(): { ingestRouter: IRouter; reportRouter: IRouter } {
  const ingestRouter = Router();
  const reportRouter = Router();

  ingestRouter.post("/ingest", (req, res): void => {
    const auth = signatureValid(req);
    if (!auth) { res.status(401).json({ error: "capture_auth_failed" }); return; }
    if (!isActiveCaptureUser(auth.actorId)) { res.status(403).json({ error: "capture_user_not_allowed" }); return; }
    const body = req.body as { service?: unknown; conversationKey?: unknown; contactName?: unknown; messages?: unknown };
    if (typeof body.service !== "string" || !SERVICES.has(body.service)
      || typeof body.conversationKey !== "string" || !body.conversationKey.trim() || body.conversationKey.length > 240
      || typeof body.contactName !== "string" || !body.contactName.trim() || body.contactName.length > 180
      || !Array.isArray(body.messages) || body.messages.length < 1 || body.messages.length > MAX_BATCH) {
      res.status(400).json({ error: "invalid_capture_batch" }); return;
    }
    const messages = body.messages as Array<Record<string, unknown>>;
    const normalized: Array<{ key: string; direction: string; text: string; occurredAt: string; localDay: string; known: number }> = [];
    for (const item of messages) {
      const key = typeof item.key === "string" ? item.key.trim().slice(0, 180) : "";
      const text = typeof item.text === "string" ? item.text.trim().slice(0, MAX_TEXT) : "";
      const direction = item.direction;
      const occurredAt = typeof item.occurredAt === "string" && Number.isFinite(Date.parse(item.occurredAt))
        ? new Date(item.occurredAt).toISOString() : now();
      if (!key || !text || (direction !== "inbound" && direction !== "outbound")) {
        res.status(400).json({ error: "invalid_capture_message" }); return;
      }
      normalized.push({ key, direction, text, occurredAt, localDay: dayInTehran(occurredAt), known: item.timestampKnown === true ? 1 : 0 });
    }
    const insert = crmDb.prepare(`
      INSERT INTO social_monitor_messages
        (employee_user_id,service,conversation_key,contact_name,message_key,direction,message_text,occurred_at,local_day,captured_at,timestamp_known)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(employee_user_id,service,conversation_key,message_key) DO UPDATE SET
        contact_name=excluded.contact_name,direction=excluded.direction,message_text=excluded.message_text,
        captured_at=excluded.captured_at
    `);
    crmDb.exec("BEGIN IMMEDIATE");
    try {
      const used = crmDb.prepare("INSERT OR IGNORE INTO social_monitor_capture_nonces(nonce,used_at) VALUES(?,?)").run(auth.nonce, now());
      if (Number(used.changes) !== 1) {
        crmDb.exec("ROLLBACK");
        res.status(409).json({ error: "capture_replay" });
        return;
      }
      const days = new Set<string>();
      for (const item of normalized) {
        const existing = crmDb.prepare(`SELECT local_day FROM social_monitor_messages
          WHERE employee_user_id=? AND service=? AND conversation_key=? AND message_key=?`)
          .get(auth.actorId, body.service, body.conversationKey, item.key) as { local_day: string } | undefined;
        insert.run(auth.actorId, body.service, body.conversationKey, body.contactName.trim().slice(0, 180),
          item.key, item.direction, item.text, item.occurredAt, item.localDay, now(), item.known);
        days.add(existing?.local_day || item.localDay);
      }
      for (const day of days) {
        const aggregate = crmDb.prepare(`
          SELECT COUNT(DISTINCT service||':'||conversation_key) AS conversations,
            SUM(direction='inbound') AS inbound,SUM(direction='outbound') AS outbound,
            GROUP_CONCAT(DISTINCT service) AS services
          FROM social_monitor_messages WHERE employee_user_id=? AND local_day=?
        `).get(auth.actorId, day) as { conversations: number; inbound: number | null; outbound: number | null; services: string | null };
        const inbound = Number(aggregate.inbound || 0), outbound = Number(aggregate.outbound || 0);
        const services = (aggregate.services || "").split(",").filter(Boolean);
        const summary = `${Number(aggregate.conversations || 0)} گفتگوی بازشده؛ ${inbound} پیام مشتری و ${outbound} پیام کارشناس در ${services.length} پیام‌رسان`;
        crmDb.prepare(`
          INSERT INTO social_monitor_daily_summaries
            (employee_user_id,local_day,conversation_count,inbound_count,outbound_count,services_json,summary,updated_at)
          VALUES(?,?,?,?,?,?,?,?)
          ON CONFLICT(employee_user_id,local_day) DO UPDATE SET
            conversation_count=excluded.conversation_count,inbound_count=excluded.inbound_count,
            outbound_count=excluded.outbound_count,services_json=excluded.services_json,
            summary=excluded.summary,updated_at=excluded.updated_at
        `).run(auth.actorId, day, Number(aggregate.conversations || 0), inbound, outbound,
          JSON.stringify(services), summary, now());
      }
      crmDb.prepare("DELETE FROM social_monitor_capture_nonces WHERE used_at < ?").run(new Date(Date.now() - 24 * 3600_000).toISOString());
      crmDb.exec("COMMIT");
    } catch (error) {
      crmDb.exec("ROLLBACK");
      throw error;
    }
    res.status(202).json({ accepted: normalized.length });
  });

  reportRouter.use("/social-monitor", requireAuth, requireAdmin);
  reportRouter.get("/social-monitor/reports", (req, res): void => {
    const from = req.query.from, to = req.query.to;
    if (!validDay(from) || !validDay(to) || from > to || Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`) > 93 * 86400_000) {
      res.status(400).json({ error: "بازهٔ گزارش باید حداکثر ۹۳ روز باشد." }); return;
    }
    const userId = req.query.employeeId === undefined ? null : Number(req.query.employeeId);
    const service = req.query.service === undefined || req.query.service === "" ? null : String(req.query.service);
    if (userId !== null && (!Number.isSafeInteger(userId) || userId < 1)) { res.status(400).json({ error: "کارشناس معتبر نیست." }); return; }
    if (service !== null && !SERVICES.has(service)) { res.status(400).json({ error: "پیام‌رسان معتبر نیست." }); return; }
    const userClause = userId === null ? "" : " AND m.employee_user_id=?";
    const serviceClause = service === null ? "" : " AND m.service=?";
    const params: (string | number)[] = [from, to];
    if (userId !== null) params.push(userId);
    if (service !== null) params.push(service);
    const employees = queryRows<{ id: number; name: string }>(`
      SELECT DISTINCT u.id,COALESCE(NULLIF(u.full_name,''),u.username) AS name
      FROM users u JOIN social_monitor_messages m ON m.employee_user_id=u.id
      WHERE m.local_day BETWEEN ? AND ? ORDER BY name,u.id
    `, [from, to]);
    const days = queryRows<Record<string, unknown>>(`
      SELECT m.employee_user_id AS employeeId,COALESCE(NULLIF(u.full_name,''),u.username,'کاربر حذف‌شده') AS employeeName,
        m.local_day AS day,COUNT(DISTINCT m.service||':'||m.conversation_key) AS conversationCount,
        SUM(m.direction='inbound') AS inboundCount,SUM(m.direction='outbound') AS outboundCount,
        COUNT(*) AS messageCount,GROUP_CONCAT(DISTINCT m.service) AS services,
        MAX(CASE WHEN ? IS NULL THEN ds.summary ELSE NULL END) AS summary
      FROM social_monitor_messages m LEFT JOIN users u ON u.id=m.employee_user_id
      LEFT JOIN social_monitor_daily_summaries ds ON ds.employee_user_id=m.employee_user_id AND ds.local_day=m.local_day
      WHERE m.local_day BETWEEN ? AND ?${userClause}${serviceClause}
      GROUP BY m.employee_user_id,m.local_day ORDER BY m.local_day DESC,employeeName
    `, [service, ...params]);
    const conversations = socialThreadReport(from, to, userId, service);
    res.setHeader("Cache-Control", "private, no-store");
    res.json({ employees, days, conversations });
  });
  reportRouter.get("/social-monitor/messages", (req, res): void => {
    const day = req.query.day, employeeId = Number(req.query.employeeId), conversationKey = req.query.conversationKey;
    const service = req.query.service;
    if (!validDay(day) || !Number.isSafeInteger(employeeId) || employeeId < 1 || typeof conversationKey !== "string"
      || !conversationKey || conversationKey.length > 240 || typeof service !== "string" || !SERVICES.has(service)) {
      res.status(400).json({ error: "مشخصات گفت‌وگو معتبر نیست." }); return;
    }
    const messages = queryRows<Record<string, unknown>>(`
      SELECT message_key AS messageKey,direction,message_text AS text,occurred_at AS occurredAt,contact_name AS contactName,timestamp_known AS timestampKnown
      FROM social_monitor_messages
      WHERE employee_user_id=? AND service=? AND conversation_key=? AND local_day=?
      ORDER BY occurred_at,id LIMIT 500
    `, [employeeId, service, conversationKey, day]);
    res.setHeader("Cache-Control", "private, no-store");
    res.json({ messages: messages.map(m => ({ ...m, timestampKnown: Number(m.timestampKnown) === 1 })) });
  });
  attachSocialThreads(reportRouter);
  return { ingestRouter, reportRouter };
}

export const socialMonitorFeature = createSocialMonitorFeature();
