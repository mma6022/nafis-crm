import type { IRouter } from "express";
import { createHash } from "node:crypto";
import { crmDb, queryRows } from "./crm-db";
import { socialSummaryConfigured, summarizeSocialTranscript } from "./social-thread-summary";
import { createSocialContactMatcher, normalizeContact as normalize } from "./social-contact-match";

type Customer = { id: number; name: string };
type Source = { employeeId: number; employeeName: string; service: string; conversationKey: string; contactName: string; firstMessageAt: string; lastMessageAt: string; messageCount: number; inboundCount: number; outboundCount: number };
type Thread = Omit<Source, "service" | "conversationKey"> & {
  threadId: string; customerId: number | null; customerName: string | null;
  customerMatch: "linked" | "exact" | "ambiguous" | "none"; customerCandidates: Customer[];
  services: string[]; sourceCount: number; sources: Source[];
};
type Message = { id: number; messageKey: string; direction: string; text: string; occurredAt: string; day: string; contactName: string; timestampKnown: number; service: string };
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
const sourceKey = (s: { service: string; conversationKey: string }) => s.service + ":" + s.conversationKey;
const publicThread = ({ sources: _sources, ...thread }: Thread) => thread;
const jobs = new Set<string>();

function customers() {
  return queryRows<{ id: number; name: string; first_name: string; last_name: string }>(
    "SELECT id,name,first_name,last_name FROM customers WHERE merged_into_customer_id IS NULL");
}
function catalog(): Thread[] {
  const people = customers();
  const matchContact = createSocialContactMatcher(people);
  const links = queryRows<{ employeeId: number; service: string; conversationKey: string; customerId: number }>(
    "SELECT employee_user_id AS employeeId,service,conversation_key AS conversationKey,customer_id AS customerId FROM social_monitor_customer_links");
  const linked = new Map(links.map(l => [l.employeeId + ":" + sourceKey(l), l.customerId]));
  const sources = queryRows<Source>(`WITH grouped AS (
    SELECT employee_user_id,service,conversation_key,MAX(id) AS last_id,
      MIN(occurred_at) AS firstMessageAt,MAX(occurred_at) AS lastMessageAt,
      COUNT(*) AS messageCount,SUM(direction='inbound') AS inboundCount,SUM(direction='outbound') AS outboundCount
      FROM social_monitor_messages GROUP BY employee_user_id,service,conversation_key)
    SELECT m.employee_user_id AS employeeId,
    COALESCE(NULLIF(u.full_name,''),u.username,'کاربر حذف‌شده') AS employeeName,
    m.service,m.conversation_key AS conversationKey,latest.contact_name AS contactName,
    m.firstMessageAt,m.lastMessageAt,m.messageCount,m.inboundCount,m.outboundCount
    FROM grouped m LEFT JOIN users u ON u.id=m.employee_user_id
    JOIN social_monitor_messages latest ON latest.id=m.last_id`);
  const grouped = new Map<string, Thread>();
  for (const source of sources) {
    const explicit = linked.get(source.employeeId + ":" + sourceKey(source));
    const match = matchContact(source.contactName);
    const exact = match.candidates.map(p => ({ id: p.id, name: p.name || `${p.first_name || ""} ${p.last_name || ""}`.trim() }));
    const target = explicit ? people.find(p => p.id === explicit) : match.target;
    const customerId = target?.id || null;
    const threadId = digest(JSON.stringify([source.employeeId, customerId ? "customer:" + customerId : "name:" + normalize(source.contactName)]));
    const previous = grouped.get(threadId);
    if (previous) {
      previous.sources.push(source); previous.sourceCount++;
      previous.messageCount += source.messageCount; previous.inboundCount += source.inboundCount; previous.outboundCount += source.outboundCount;
      previous.firstMessageAt = [previous.firstMessageAt, source.firstMessageAt].sort()[0]!;
      previous.lastMessageAt = [previous.lastMessageAt, source.lastMessageAt].sort().at(-1)!;
      if (!previous.services.includes(source.service)) previous.services.push(source.service);
      if (explicit) previous.customerMatch = "linked";
    } else grouped.set(threadId, {
      ...source, threadId, customerId, customerName: target?.name || null,
      customerMatch: explicit && target ? "linked" : target ? "exact" : exact.length ? "ambiguous" : "none",
      customerCandidates: exact, services: [source.service], sourceCount: 1, sources: [source],
    });
  }
  return [...grouped.values()];
}
function findThread(id: unknown) { return typeof id === "string" && /^[a-f0-9]{64}$/.test(id) ? catalog().find(t => t.threadId === id) : undefined; }
function sourceParams(thread: Thread) { return [thread.employeeId, JSON.stringify(thread.sources.map(sourceKey))]; }
const threadWhere = "employee_user_id=? AND service||':'||conversation_key IN (SELECT value FROM json_each(?))";
function transcript(thread: Thread) {
  const size = crmDb.prepare(`SELECT COALESCE(SUM(length(message_text)),0) AS size FROM social_monitor_messages WHERE ${threadWhere}`)
    .get(...sourceParams(thread)) as { size: number };
  if (size.size > 2_000_000) throw new Error("حجم کل گفتگو برای خلاصه‌نویسی یک‌مرحله‌ای بیش از حد مجاز است؛ خلاصهٔ ناقص ساخته نمی‌شود.");
  return queryRows<Message>(`SELECT id,message_key AS messageKey,direction,message_text AS text,
    occurred_at AS occurredAt,local_day AS day,contact_name AS contactName,timestamp_known AS timestampKnown,service
    FROM social_monitor_messages WHERE ${threadWhere} ORDER BY occurred_at,id`, sourceParams(thread));
}
const fingerprint = (messages: Message[]) => digest(JSON.stringify(messages.map(m => [m.id, m.direction, m.text, m.occurredAt, m.timestampKnown])));
function summaryState(thread: Thread) {
  const row = crmDb.prepare("SELECT fingerprint,status,summary AS text,error,updated_at AS updatedAt FROM social_monitor_thread_summaries WHERE thread_id=?")
    .get(thread.threadId) as { fingerprint: string; status: string; text: string; error: string; updatedAt: string } | undefined;
  if (!row) return { status: "none" };
  if (row.status === "pending" && !jobs.has(thread.threadId)) return { status: "error", error: "ساخت خلاصه با راه‌اندازی مجدد متوقف شده است؛ دوباره درخواست کنید." };
  return { status: row.status, text: row.text || undefined, error: row.error || undefined, updatedAt: row.updatedAt,
    stale: row.status === "ready" && row.fingerprint !== fingerprint(transcript(thread)) };
}

export function socialThreadReport(from: string, to: string, employeeId: number | null, service: string | null) {
  const all = catalog(), membership = new Map<string, Thread>();
  for (const thread of all) for (const source of thread.sources) membership.set(thread.employeeId + ":" + sourceKey(source), thread);
  const period = queryRows<{ employeeId: number; service: string; conversationKey: string; day: string; messageCount: number; inboundCount: number; outboundCount: number }>(
    `SELECT employee_user_id AS employeeId,service,conversation_key AS conversationKey,COUNT(*) AS messageCount,
      SUM(direction='inbound') AS inboundCount,SUM(direction='outbound') AS outboundCount,MAX(local_day) AS day
      FROM social_monitor_messages WHERE local_day BETWEEN ? AND ? AND (? IS NULL OR employee_user_id=?) AND (? IS NULL OR service=?)
      GROUP BY employee_user_id,service,conversation_key`, [from, to, employeeId, employeeId, service, service]);
  // Keep an actual source/day for already-open legacy report clients until they reload.
  const result = new Map<string, ReturnType<typeof publicThread> & { day: string; service: string; conversationKey: string }>();
  for (const row of period) {
    const thread = membership.get(row.employeeId + ":" + sourceKey(row));
    if (!thread) continue;
    const previous = result.get(thread.threadId);
    if (previous) {
      previous.messageCount += row.messageCount; previous.inboundCount += row.inboundCount; previous.outboundCount += row.outboundCount;
      if (row.day > previous.day) { previous.day = row.day; previous.service = row.service; previous.conversationKey = row.conversationKey; }
    } else result.set(thread.threadId, { ...publicThread(thread), day: row.day, service: row.service, conversationKey: row.conversationKey,
      messageCount: row.messageCount, inboundCount: row.inboundCount, outboundCount: row.outboundCount });
  }
  return [...result.values()].sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt) || a.threadId.localeCompare(b.threadId));
}

export function attachSocialThreads(router: IRouter) {
  crmDb.exec(`CREATE TABLE IF NOT EXISTS social_monitor_customer_links(
    employee_user_id INTEGER NOT NULL,service TEXT NOT NULL,conversation_key TEXT NOT NULL,
    customer_id INTEGER NOT NULL,linked_by INTEGER NOT NULL,updated_at TEXT NOT NULL,
    PRIMARY KEY(employee_user_id,service,conversation_key));
    CREATE TABLE IF NOT EXISTS social_monitor_thread_summaries(
    thread_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,status TEXT NOT NULL,summary TEXT,error TEXT,
    requested_by INTEGER NOT NULL,updated_at TEXT NOT NULL);`);
  router.get("/social-monitor/customers", (req, res) => {
    const search = normalize(String(req.query.search || "").slice(0, 180));
    res.setHeader("Cache-Control", "private, no-store");
    res.json({ customers: !search || (search.length < 2 && !/^\d+$/.test(search)) ? [] : customers().filter(p => String(p.id) === search || normalize(p.name || "").includes(search) ||
      normalize(`${p.first_name || ""} ${p.last_name || ""}`).includes(search)).slice(0, 30).map(p => ({ id: p.id, name: p.name })) });
  });
  router.get("/social-monitor/threads/:threadId/messages", (req, res) => {
    const thread = findThread(req.params.threadId);
    if (!thread) { res.status(404).json({ error: "گفتگو پیدا نشد؛ فهرست را به‌روزرسانی کنید." }); return; }
    let before: [string, number] | null = null;
    if (req.query.before !== undefined) try {
      const value = JSON.parse(Buffer.from(String(req.query.before), "base64url").toString());
      if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== "string" || !Number.isFinite(Date.parse(value[0])) || !Number.isSafeInteger(value[1]) || value[1] < 1) throw Error();
      before = value as [string, number];
    } catch { res.status(400).json({ error: "صفحهٔ تاریخچه معتبر نیست." }); return; }
    const params = sourceParams(thread);
    if (before) params.push(before[0], before[0], before[1]);
    const rows = queryRows<Message>(`SELECT id,message_key AS messageKey,direction,message_text AS text,
      occurred_at AS occurredAt,local_day AS day,contact_name AS contactName,timestamp_known AS timestampKnown,service
      FROM social_monitor_messages WHERE ${threadWhere}${before ? " AND (occurred_at<? OR (occurred_at=? AND id<?))" : ""}
      ORDER BY occurred_at DESC,id DESC LIMIT 201`, params);
    const hasMore = rows.length > 200;
    const messages = rows.slice(0, 200).reverse(), first = messages[0];
    res.setHeader("Cache-Control", "private, no-store");
    res.json({ thread: publicThread(thread), messages: messages.map(m => ({ ...m, timestampKnown: m.timestampKnown === 1 })),
      hasMore, olderCursor: hasMore && first ? Buffer.from(JSON.stringify([first.occurredAt, first.id])).toString("base64url") : null });
  });
  router.post("/social-monitor/threads/:threadId/customer", (req, res) => {
    const thread = findThread(req.params.threadId), customerId = Number(req.body?.customerId);
    if (!thread) { res.status(404).json({ error: "گفتگو پیدا نشد." }); return; }
    if (!Number.isSafeInteger(customerId) || !customers().some(c => c.id === customerId)) { res.status(400).json({ error: "مشتری معتبر نیست." }); return; }
    const actorId = Number(res.locals.authUser?.id);
    if (!Number.isSafeInteger(actorId) || actorId < 1) { res.status(403).json({ error: "هویت مدیر معتبر نیست." }); return; }
    crmDb.exec("BEGIN IMMEDIATE");
    try {
      const save = crmDb.prepare(`INSERT INTO social_monitor_customer_links VALUES(?,?,?,?,?,?)
        ON CONFLICT(employee_user_id,service,conversation_key) DO UPDATE SET customer_id=excluded.customer_id,
        linked_by=excluded.linked_by,updated_at=excluded.updated_at`);
      for (const source of thread.sources) save.run(thread.employeeId, source.service, source.conversationKey, customerId, actorId, new Date().toISOString());
      crmDb.exec("COMMIT");
    } catch (error) { crmDb.exec("ROLLBACK"); throw error; }
    res.json({ ok: true });
  });
  router.get("/social-monitor/threads/:threadId/summary", (req, res) => {
    const thread = findThread(req.params.threadId);
    if (!thread) { res.status(404).json({ error: "گفتگو پیدا نشد." }); return; }
    res.setHeader("Cache-Control", "private, no-store");
    try { res.json(summaryState(thread)); } catch (e) { res.status(413).json({ error: (e as Error).message }); }
  });
  router.post("/social-monitor/threads/:threadId/summary", (req, res) => {
    const thread = findThread(req.params.threadId);
    if (!thread) { res.status(404).json({ error: "گفتگو پیدا نشد." }); return; }
    if (jobs.has(thread.threadId)) { res.status(202).json({ status: "pending" }); return; }
    let messages: Message[];
    try {
      const existing = summaryState(thread);
      if (existing.status === "ready" && !existing.stale) { res.json(existing); return; }
      messages = transcript(thread);
    } catch (e) { res.status(413).json({ error: (e as Error).message }); return; }
    if (!messages.length) { res.status(400).json({ error: "پیامی برای خلاصه‌نویسی وجود ندارد." }); return; }
    if (!socialSummaryConfigured()) { res.status(503).json({ error: "سرویس OpenAI برای خلاصه‌نویسی تنظیم نشده است." }); return; }
    if (jobs.size >= 2) { res.status(429).json({ error: "دو خلاصه در حال ساخت است؛ کمی بعد دوباره تلاش کنید." }); return; }
    const actorId = Number(res.locals.authUser?.id);
    if (!Number.isSafeInteger(actorId) || actorId < 1) { res.status(403).json({ error: "هویت مدیر معتبر نیست." }); return; }
    const hash = fingerprint(messages), id = thread.threadId;
    crmDb.prepare(`INSERT INTO social_monitor_thread_summaries(thread_id,fingerprint,status,summary,error,requested_by,updated_at)
      VALUES(?,?,'pending',NULL,NULL,?,?) ON CONFLICT(thread_id) DO UPDATE SET fingerprint=excluded.fingerprint,
      status='pending',summary=NULL,error=NULL,requested_by=excluded.requested_by,updated_at=excluded.updated_at`)
      .run(id, hash, actorId, new Date().toISOString());
    jobs.add(id);
    void summarizeSocialTranscript(messages.map(m => JSON.stringify({
      time: m.occurredAt, timeMeaning: m.timestampKnown ? "زمان پیام" : "زمان مشاهده؛ زمان ارسال معلوم نیست",
      speaker: m.direction === "inbound" ? "مشتری" : "کارشناس", service: m.service, text: m.text,
    }))).then(text => {
      crmDb.prepare("UPDATE social_monitor_thread_summaries SET status='ready',summary=?,error=NULL,updated_at=? WHERE thread_id=? AND fingerprint=?")
        .run(text, new Date().toISOString(), id, hash);
    }).catch(error => {
      crmDb.prepare("UPDATE social_monitor_thread_summaries SET status='error',error=?,updated_at=? WHERE thread_id=? AND fingerprint=?")
        .run(error instanceof Error ? error.message : "خلاصه‌نویسی ناموفق بود.", new Date().toISOString(), id, hash);
    }).finally(() => jobs.delete(id));
    res.status(202).json({ status: "pending" });
  });
}
