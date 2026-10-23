import {
  execute,
  executeChanges,
  queryRow,
  queryRows,
  runImmediateTransaction,
} from "./crm-db";
import { insertCustomerRecord } from "./customer-create";
import { normalizeCustomerMobile } from "./customer-integrity";
import {
  extractInstagramIntakeIdentityDeterministically,
  instagramIntakeRequestText,
} from "./instagram-intake-identity";
import {
  parseInstagramRequestedAmount,
  resolveInstagramRequestedAmount,
} from "./instagram-loan-packages";
import { logger } from "./logger";

export type InstagramCrmRegistrationResult = {
  kind: "created" | "repeat" | "waiting_fields" | "existing_session" | "error";
  customerId?: number;
  needsRequestQuestion?: boolean;
  question?: string;
};

export type InstagramCrmReplyOverride = {
  kind: "clarify" | "redirect";
  answer: string;
};

type ThreadRow = {
  id: number;
  name: string | null;
  full_name: string | null;
  phone: string | null;
  customer_id: number | null;
};

type SessionRow = {
  id: number;
  thread_id: number;
  episode_id: string;
  source_message_id: string;
  state: string;
  customer_id: number | null;
  name_snapshot: string | null;
  phone_snapshot: string | null;
  request_summary: string | null;
  is_urgent: number;
  due_at: string | null;
  question_delivered_at: string | null;
  delivery_reset: number;
  attempts: number;
  error: string | null;
  created_at: string;
};

type InboundRow = {
  id: number;
  mid: string;
  content: string;
  sent_at: string;
};

const REPEAT_QUESTION = "برای این درخواست چه مبلغی نیاز دارید؟";
const FIELD_QUESTION = "برای تکمیل ثبت، لطفاً نام و نام خانوادگی و شماره موبایل ایران را بفرمایید.";
const REQUEST_WAIT = "repeat_waiting_request";
const FIELD_WAIT = "waiting_fields";
const REGISTRATION_RETRY = "registration_retry";
const AUTOMATION_PROVENANCE = "instagram_automation";
const THIRTY_MINUTES_MS = 30 * 60 * 1000;
const RETRY_DELAY_MS = 5 * 60 * 1000;
const MAX_RETRIES = 5;
const PURE_AMOUNT_RESPONSE =
  /^\s*[\d۰-۹٠-٩][\d۰-۹٠-٩٬, ]*(?:\.\d+)?\s*(?:(?:هزار|میلیون(?:ی)?|میلیارد(?:ی)?|بیلیون(?:ی)?)(?:\s*(?:تومان|تومن|تومانی|ریال|ریالی))?|تومان|تومن|تومانی|ریال|ریالی)?\s*$/u;

function normalizeText(value: string): string {
  return String(value ?? "").normalize("NFC").replace(/[يى]/g, "ی").replace(/ك/g, "ک")
    .replace(/\u200c/g, " ").replace(/\s+/g, " ").trim();
}

function validIranianMobile(value: unknown): string | null {
  const mobile = normalizeCustomerMobile(value);
  return /^09\d{9}$/.test(mobile) ? mobile : null;
}

function validFullName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const fullName = normalizeText(value);
  const words = fullName.split(/\s+/).filter(Boolean);
  if (fullName.length > 100 || words.length < 2 || words.length > 5) return null;
  if (words.some((word) => !/^[\p{L}‌-]{2,}$/u.test(word))) return null;
  return fullName;
}

function findThread(threadId: number): ThreadRow | undefined {
  return queryRow<ThreadRow>(
    `SELECT id,name,full_name,phone,customer_id
     FROM instagram_threads WHERE id=?`,
    [threadId],
  );
}

function getInbound(threadId: number, sourceMessageId: string): InboundRow | undefined {
  return queryRow<InboundRow>(
    `SELECT id,mid,content,sent_at FROM instagram_messages
     WHERE thread_id=? AND mid=? AND direction='inbound'`,
    [threadId, sourceMessageId],
  );
}

function latestSession(threadId: number): SessionRow | undefined {
  return queryRow<SessionRow>(
    `SELECT * FROM instagram_crm_automation_sessions
     WHERE thread_id=? ORDER BY id DESC LIMIT 1`,
    [threadId],
  );
}

function sessionBySource(sourceMessageId: string): SessionRow | undefined {
  return queryRow<SessionRow>(
    "SELECT * FROM instagram_crm_automation_sessions WHERE source_message_id=?",
    [sourceMessageId],
  );
}

function isUrgentIntent(text: string): boolean {
  return extractInstagramIntakeIdentityDeterministically([
    { mid: "instagram-crm-urgency", content: text },
  ]).urgent;
}

function extractRequestedAmountReply(raw: string) {
  if (PURE_AMOUNT_RESPONSE.test(raw) && validIranianMobile(raw)) return { status: "none" as const };
  const resolved = resolveInstagramRequestedAmount([
    { role: "assistant", content: REPEAT_QUESTION },
    { role: "user", content: raw },
  ]);
  if (resolved.status !== "none") return resolved;

  // A numeric-only reply has no request cue of its own. Permit it only in the
  // amount-question path, and let the shared parser validate the amount,
  // currency and phone-like-number constraints.
  if (!/^\s*[\d۰-۹٠-٩][\d۰-۹٠-٩٬, ]*(?:\.\d+)?\s*(?:تومان|تومن|تومانی|ریال|ریالی)?\s*$/u.test(raw)) {
    return resolved;
  }
  return parseInstagramRequestedAmount(`برای وام چه مبلغی ${raw}`);
}

function hasValidRequestedAmount(raw: string): boolean {
  return Boolean(raw) &&
    !hasMembershipQuestion(raw) &&
    !validIranianMobile(raw) &&
    parseInstagramRequestedAmount(raw).status === "amount";
}

function cleanUserRequest(
  raw: string,
  knownName?: string | null,
  amountQuestionAsked = false,
): string | null {
  if (!raw || hasMembershipQuestion(raw)) return null;
  const requestedAmount = amountQuestionAsked
    ? extractRequestedAmountReply(raw)
    : parseInstagramRequestedAmount(raw);
  // Preserve the exact inbound source for CRM history; parsing is validation
  // only and must not introduce a transformed or model-generated amount.
  if (
    requestedAmount.status === "amount" &&
    !validIranianMobile(raw) &&
    (amountQuestionAsked || PURE_AMOUNT_RESPONSE.test(raw))
  ) {
    return raw.slice(0, 2000);
  }
  const text = instagramIntakeRequestText(raw, knownName);
  // Once we ask for a request, a short purpose such as «برای بدهی» or an
  // address/document question is a valid answer without repeating «وام».
  // The shared intake cleaner already excludes identity-only and polite text.
  if (!text) {
    return null;
  }
  return text.slice(0, 2000);
}

function hasExplicitLoanIntent(text: string): boolean {
  return cleanUserRequest(text) !== null &&
    /(?:وام|تسهیلات|قرض|اقساط|قسط|درخواست|نیاز|مشاوره|می‌خواهم|میخوام|می‌خوام|شرایط)/iu.test(text);
}

function hasMembershipQuestion(text: string): boolean {
  return /(?:قبلا\s+ثبت|قبلاً\s+ثبت|مشتری\s+هستم|عضو\s+هستم|در\s+سیستم|پرونده(?:‌| )?ام|وضعیت\s+(?:ثبت|پرونده)|شماره(?:‌| )?ام\s+(?:ثبت|در\s+سیستم))/iu.test(text);
}

function resolveCanonicalCustomerId(customerId: number): number {
  const customer = queryRow<{ id: number; merged_into_customer_id: number | null }>(
    "SELECT id,merged_into_customer_id FROM customers WHERE id=?",
    [customerId],
  );
  if (!customer) return customerId;
  if (customer.merged_into_customer_id == null) return customer.id;
  const survivor = queryRow<{ id: number }>(
    `WITH RECURSIVE chain(id,depth) AS (
       SELECT ?,0
       UNION ALL
       SELECT audit.survivor_customer_id,chain.depth+1
       FROM chain JOIN customer_merge_audit audit ON audit.source_customer_id=chain.id
       WHERE chain.depth<100
     )
     SELECT customers.id FROM chain JOIN customers ON customers.id=chain.id
     WHERE customers.merged_into_customer_id IS NULL ORDER BY chain.depth LIMIT 1`,
    [customerId],
  );
  return survivor?.id ?? customer.id;
}

function findCustomerByMobile(mobile: string): { id: number; name: string } | undefined {
  const matches = queryRows<{ id: number; name: string; merged_into_customer_id: number | null; status: string | null }>(
    `SELECT id,name,merged_into_customer_id,status FROM customers
     WHERE crm_customer_mobile_key(phone)=?
      ORDER BY CASE WHEN merged_into_customer_id IS NULL THEN 0 ELSE 1 END,id`,
    [mobile],
  );
  const matched = matches.find((row) => row.merged_into_customer_id == null) ??
    matches.find((row) => row.merged_into_customer_id != null);
  if (!matched) return undefined;
  const canonicalId = matched.merged_into_customer_id == null
    ? matched.id
    : resolveCanonicalCustomerId(matched.id);
  const canonical = queryRow<{ id: number; name: string }>(
    "SELECT id,name FROM customers WHERE id=?",
    [canonicalId],
  );
  return canonical;
}

function markUrgent(customerId: number, urgent: boolean): void {
  if (urgent) executeChanges("UPDATE customers SET is_urgent=1 WHERE id=?", [customerId]);
}

function addSessionEvent(input: {
  threadId: number;
  sourceMessageId: string;
  episodeId: string;
  state: string;
  customerId?: number | null;
  name?: string | null;
  phone?: string | null;
  requestSummary?: string | null;
  isUrgent?: boolean;
  dueAt?: string | null;
  deliveredAt?: string | null;
  deliveryReset?: boolean;
  attempts?: number;
  error?: string | null;
  createdAt?: string;
}): number {
  return execute(
    `INSERT INTO instagram_crm_automation_sessions
      (thread_id,episode_id,source_message_id,state,customer_id,name_snapshot,phone_snapshot,
       request_summary,is_urgent,due_at,question_delivered_at,delivery_reset,attempts,error,
       provenance,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, ?,?)`,
    [
      input.threadId,
      input.episodeId,
      input.sourceMessageId,
      input.state,
      input.customerId ?? null,
      input.name ?? null,
      input.phone ?? null,
      input.requestSummary ?? null,
      input.isUrgent ? 1 : 0,
      input.dueAt ?? null,
      input.deliveredAt ?? null,
      input.deliveryReset ? 1 : 0,
      input.attempts ?? 0,
      input.error ?? null,
      AUTOMATION_PROVENANCE,
      input.createdAt ?? new Date().toISOString(),
      new Date().toISOString(),
    ],
  );
}

function finishSessionEpisode(
  threadId: number,
  episodeId: string,
  state: string,
  customerId: number | null,
  error: string | null = null,
): void {
  const now = new Date().toISOString();
  executeChanges(
    `UPDATE instagram_crm_automation_sessions
     SET state=?,customer_id=COALESCE(?,customer_id),due_at=NULL,error=?,updated_at=?,finalized_at=?
     WHERE thread_id=? AND episode_id=?`,
    [state, customerId, error, now, now, threadId, episodeId],
  );
}

function getDefaultAllocationProgramId(): number {
  const programs = queryRows<{ id: number }>(
    "SELECT id FROM allocation_programs WHERE active=1 AND is_default=1 ORDER BY id",
  );
  if (programs.length !== 1) throw new Error("ALLOCATION_PROGRAM_UNAVAILABLE");
  return Number(programs[0].id);
}

function insertRepeatRequest(input: {
  customerId: number;
  requestedName: string;
  summary: string;
  threadId: number;
  sourceMessageId: string;
  createdAt: string;
}): number {
  const requestText = input.summary.slice(0, 2000);
  const id = execute(
    `INSERT INTO customer_repeat_requests
      (customer_id,requested_name,submitted_description,explanation,status,created_by_user_id,
       provenance,source_thread_id,source_message_id,created_at)
     VALUES (?,?,?,?, 'pending',NULL,?,?,?,?)`,
    [
      input.customerId,
      input.requestedName,
      requestText || null,
      `درخواست تازه از گفت‌وگوی کاربر در اینستاگرام: ${requestText}`.slice(0, 2200),
      AUTOMATION_PROVENANCE,
      input.threadId,
      input.sourceMessageId,
      input.createdAt,
    ],
  );
  execute(
    "INSERT OR IGNORE INTO customer_tags(customer_id,tag,created_at) VALUES(?,'repeat_request',?)",
    [input.customerId, input.createdAt],
  );
  return id;
}

function finalizeRepeatEpisode(input: {
  threadId: number;
  episodeId: string;
  customerId: number;
  name: string;
  summary: string;
  sourceMessageId: string;
  urgent?: boolean;
  createdAt?: string;
  amountQuestionAsked?: boolean;
}): boolean {
  const summary = cleanUserRequest(input.summary, input.name, input.amountQuestionAsked === true);
  if (!summary) return false;
  return runImmediateTransaction(() => {
    const existing = queryRow<{ id: number }>(
      "SELECT id FROM customer_repeat_requests WHERE source_message_id=?",
      [input.sourceMessageId],
    );
    if (!existing) {
      insertRepeatRequest({
        customerId: input.customerId,
        requestedName: input.name,
        summary,
        threadId: input.threadId,
        sourceMessageId: input.sourceMessageId,
        createdAt: input.createdAt ?? new Date().toISOString(),
      });
    }
    markUrgent(input.customerId, input.urgent === true);
    finishSessionEpisode(input.threadId, input.episodeId, "completed_repeat", input.customerId);
    return true;
  });
}

function getEpisodeRequestSummary(session: SessionRow, thread: ThreadRow): string | null {
  const fromSession = cleanUserRequest(session.request_summary ?? "", session.name_snapshot, true);
  if (fromSession) return fromSession;
  const messages = queryRows<InboundRow>(
    `SELECT m.id,m.mid,m.content,m.sent_at
       FROM instagram_crm_automation_sessions episode
       JOIN instagram_messages m
         ON m.thread_id=episode.thread_id AND m.mid=episode.source_message_id
        AND m.direction='inbound'
      WHERE episode.thread_id=? AND episode.episode_id=?
      ORDER BY m.id,episode.id`,
    [session.thread_id, session.episode_id],
  );
  const userSummary = messages
    .map((message) => cleanUserRequest(
      message.content,
      session.name_snapshot ?? thread.full_name ?? thread.name,
      message.mid !== session.episode_id,
    ))
    .filter((value): value is string => Boolean(value))
    .slice(-4)
    .join("؛ ")
    .slice(0, 2000);
  return userSummary || null;
}

function completeRequestForSource(
  threadId: number,
  sourceMessageId: string,
  requestText?: string,
): void {
  const source = getInbound(threadId, sourceMessageId);
  if (!source) return;
  const thread = findThread(threadId);
  const session = latestSession(threadId);
  if (!thread || !session || session.state !== REQUEST_WAIT || !session.customer_id) return;
  const priorSourceEvent = sessionBySource(sourceMessageId);
  if (priorSourceEvent?.episode_id === session.episode_id) return;
  const raw = source.content;
  const amountReply = extractRequestedAmountReply(raw).status === "amount";
  const cleaned = cleanUserRequest(raw, session.name_snapshot, true);
  if (!cleaned) return;
  const urgent = session.is_urgent === 1 || isUrgentIntent(raw);
  // The message row is the audit source. A caller-provided extraction can only
  // narrow the text; it can never introduce content absent from the user event.
  const supplied = requestText ? normalizeText(requestText) : null;
  const trusted = amountReply
    ? raw.slice(0, 2000)
    : supplied && normalizeText(raw).includes(supplied) ? supplied : cleaned;
  if (!sessionBySource(sourceMessageId)) {
    addSessionEvent({
      threadId,
      sourceMessageId,
      episodeId: session.episode_id,
      state: REQUEST_WAIT,
      customerId: session.customer_id,
      name: session.name_snapshot,
      phone: session.phone_snapshot,
      requestSummary: session.request_summary,
      isUrgent: urgent,
      dueAt: session.due_at,
      deliveredAt: session.question_delivered_at,
      deliveryReset: session.delivery_reset === 1,
      attempts: session.attempts,
    });
  }
  finalizeRepeatEpisode({
    threadId,
    episodeId: session.episode_id,
    customerId: session.customer_id,
    name: session.name_snapshot ?? thread.full_name ?? thread.name ?? "کاربر اینستاگرام",
    summary: trusted,
    sourceMessageId,
    urgent,
    createdAt: source.sent_at,
    amountQuestionAsked: true,
  });
}

function setAllocationRetry(session: SessionRow, error: unknown, now = new Date()): void {
  const attempt = Number(session.attempts) + 1;
  const code = error instanceof Error ? error.message : "AUTOMATION_REGISTRATION_FAILED";
  const exhausted = attempt >= MAX_RETRIES;
  const timestamp = now.toISOString();
  executeChanges(
    `UPDATE instagram_crm_automation_sessions
     SET state=?,attempts=?,error=?,due_at=?,updated_at=?,finalized_at=?
     WHERE thread_id=? AND episode_id=?`,
    [
      exhausted ? "needs_human" : REGISTRATION_RETRY,
      attempt,
      code.slice(0, 200),
      exhausted ? null : new Date(now.getTime() + RETRY_DELAY_MS).toISOString(),
      timestamp,
      exhausted ? timestamp : null,
      session.thread_id,
      session.episode_id,
    ],
  );
  if (exhausted) {
    logger.warn({ threadId: session.thread_id, error: code }, "Instagram CRM registration retry exhausted; needs human review");
  }
}

function createNewCustomer(
  threadId: number,
  episodeId: string,
  name: string,
  phone: string,
  requestSummary: string | null,
  urgent: boolean,
): number {
  return runImmediateTransaction(() => {
    const existing = findCustomerByMobile(phone);
    if (existing) throw new Error("NORMALIZED_MOBILE_ALREADY_EXISTS");
    const allocationProgramId = getDefaultAllocationProgramId();
    const customerId = insertCustomerRecord({
      name,
      phone,
      description: requestSummary,
      allocationProgramId,
      priority: null,
      isUrgent: urgent,
    });
    executeChanges(
      `UPDATE instagram_threads SET customer_id=COALESCE(customer_id,?),updated_at=?
       WHERE id=?`,
      [customerId, new Date().toISOString(), threadId],
    );
    finishSessionEpisode(threadId, episodeId, "completed_new", customerId);
    // Keep the source event linked to the result even if callers replay it.
    executeChanges(
      `UPDATE instagram_crm_automation_sessions
       SET customer_id=?,name_snapshot=?,phone_snapshot=?,request_summary=?,is_urgent=?,
           updated_at=?,finalized_at=?
       WHERE thread_id=? AND episode_id=?`,
      [
        customerId,
        name,
        phone,
        requestSummary,
        urgent ? 1 : 0,
        new Date().toISOString(),
        new Date().toISOString(),
        threadId,
        episodeId,
      ],
    );
    return customerId;
  });
}

function finalizeAsRepeat(
  thread: ThreadRow,
  session: SessionRow,
  customer: { id: number; name: string },
  requestSummary: string | null,
  urgent: boolean,
): InstagramCrmRegistrationResult {
  return runImmediateTransaction(() => {
    const current = queryRow<{ customer_id: number | null }>(
      "SELECT customer_id FROM instagram_threads WHERE id=?",
      [thread.id],
    );
    if (current?.customer_id != null && Number(current.customer_id) !== customer.id) {
      finishSessionEpisode(thread.id, session.episode_id, "needs_human", null, "thread_customer_conflict");
      return { kind: "error" as const };
    }
    executeChanges(
      `UPDATE instagram_threads SET customer_id=COALESCE(customer_id,?),updated_at=? WHERE id=?`,
      [customer.id, new Date().toISOString(), thread.id],
    );
    markUrgent(customer.id, urgent);
    execute(
      "INSERT OR IGNORE INTO customer_tags(customer_id,tag,created_at) VALUES(?,'repeat_request',?)",
      [customer.id, new Date().toISOString()],
    );
    const initialSource = getInbound(thread.id, session.episode_id);
    if (initialSource && hasValidRequestedAmount(initialSource.content)) {
      const existingRequest = queryRow<{ id: number }>(
        "SELECT id FROM customer_repeat_requests WHERE source_message_id=?",
        [session.episode_id],
      );
      if (!existingRequest) {
        insertRepeatRequest({
          customerId: customer.id,
          requestedName: session.name_snapshot ?? thread.full_name ?? thread.name ?? customer.name,
          summary: initialSource.content,
          threadId: thread.id,
          sourceMessageId: session.episode_id,
          createdAt: initialSource.sent_at,
        });
      }
      executeChanges(
        `UPDATE instagram_crm_automation_sessions SET request_summary=?,updated_at=?
         WHERE thread_id=? AND episode_id=?`,
        [initialSource.content.slice(0, 2000), new Date().toISOString(), thread.id, session.episode_id],
      );
      finishSessionEpisode(thread.id, session.episode_id, "completed_repeat", customer.id);
      return { kind: "repeat" as const, customerId: customer.id };
    }
    const chosenSummary = cleanUserRequest(requestSummary ?? "", session.name_snapshot);
    finishSessionEpisode(thread.id, session.episode_id, REQUEST_WAIT, customer.id);
    // The first 30-minute deadline is based on event receipt. A successful
    // question handoff may reset it once to 30 minutes after delivery.
    const initialDue = new Date(Date.now() + THIRTY_MINUTES_MS).toISOString();
    executeChanges(
      `UPDATE instagram_crm_automation_sessions
       SET state=?,customer_id=?,name_snapshot=?,phone_snapshot=?,request_summary=?,is_urgent=?,
           due_at=?,question_delivered_at=NULL,delivery_reset=0,updated_at=?,finalized_at=NULL
       WHERE thread_id=? AND episode_id=?`,
      [
        REQUEST_WAIT,
        customer.id,
        session.name_snapshot ?? customer.name,
        session.phone_snapshot,
        chosenSummary,
        urgent ? 1 : 0,
        initialDue,
        new Date().toISOString(),
        thread.id,
        session.episode_id,
      ],
    );
    return {
      kind: "repeat" as const,
      customerId: customer.id,
      needsRequestQuestion: true,
      question: REPEAT_QUESTION,
    };
  });
}

function recordIgnoredEvent(threadId: number, sourceMessageId: string, now: string): void {
  addSessionEvent({
    threadId,
    sourceMessageId,
    episodeId: sourceMessageId,
    state: "ignored",
    createdAt: now,
  });
}

function priorInboundAt(threadId: number, sourceMessageId: string): string | null {
  return queryRow<{ sent_at: string }>(
    `SELECT sent_at FROM instagram_messages
     WHERE thread_id=? AND direction='inbound' AND mid<>?
     ORDER BY sent_at DESC,id DESC LIMIT 1`,
    [threadId, sourceMessageId],
  )?.sent_at ?? null;
}

function createEpisodeRow(input: {
  threadId: number;
  sourceMessageId: string;
  name: string | null;
  phone: string | null;
  summary: string | null;
  urgent: boolean;
  state: string;
  dueAt?: string | null;
  now: string;
}): SessionRow {
  addSessionEvent({
    threadId: input.threadId,
    sourceMessageId: input.sourceMessageId,
    episodeId: input.sourceMessageId,
    state: input.state,
    name: input.name,
    phone: input.phone,
    requestSummary: input.summary,
    isUrgent: input.urgent,
    dueAt: input.dueAt,
    createdAt: input.now,
  });
  const row = sessionBySource(input.sourceMessageId);
  if (!row) throw new Error("INSTAGRAM_CRM_SESSION_INSERT_FAILED");
  return row;
}

function continueSessionWithInbound(
  thread: ThreadRow,
  previous: SessionRow,
  sourceMessageId: string,
  name: string | null,
  phone: string | null,
  summary: string | null,
  urgent: boolean,
  inbound: InboundRow,
): SessionRow {
  addSessionEvent({
    threadId: thread.id,
    sourceMessageId,
    episodeId: previous.episode_id,
    state: previous.state,
    customerId: previous.customer_id,
    name: name ?? previous.name_snapshot,
    phone: phone ?? previous.phone_snapshot,
    requestSummary: summary ?? previous.request_summary,
    isUrgent: urgent || previous.is_urgent === 1,
    dueAt: previous.due_at,
    deliveredAt: previous.question_delivered_at,
    deliveryReset: previous.delivery_reset === 1,
    attempts: previous.attempts,
    error: previous.error,
    createdAt: inbound.sent_at,
  });
  const row = sessionBySource(sourceMessageId);
  if (!row) throw new Error("INSTAGRAM_CRM_SESSION_INSERT_FAILED");
  return row;
}

function registrationForSession(
  thread: ThreadRow,
  session: SessionRow,
  inbound: InboundRow,
  urgent: boolean,
): InstagramCrmRegistrationResult {
  const name = validFullName(thread.full_name ?? thread.name);
  const phone = validIranianMobile(thread.phone);
  if (!name || !phone) {
    executeChanges(
      `UPDATE instagram_crm_automation_sessions
       SET state=?,name_snapshot=COALESCE(?,name_snapshot),phone_snapshot=COALESCE(?,phone_snapshot),
           updated_at=? WHERE thread_id=? AND episode_id=?`,
      [FIELD_WAIT, name, phone, new Date().toISOString(), thread.id, session.episode_id],
    );
    return { kind: "waiting_fields", question: FIELD_QUESTION };
  }

  const existing = findCustomerByMobile(phone);
  const alreadyLinked = thread.customer_id == null ? null : resolveCanonicalCustomerId(Number(thread.customer_id));
  if (alreadyLinked != null && existing && existing.id !== alreadyLinked) {
    finishSessionEpisode(thread.id, session.episode_id, "needs_human", alreadyLinked, "thread_customer_conflict");
    return { kind: "error", customerId: alreadyLinked };
  }
  if (alreadyLinked != null && !existing) {
    // A previously linked conversation is never reassigned merely because a
    // typed number differs from its CRM profile.
    finishSessionEpisode(thread.id, session.episode_id, "needs_human", alreadyLinked, "linked_customer_mobile_mismatch");
    return { kind: "error", customerId: alreadyLinked };
  }
  const requestSummary = getEpisodeRequestSummary(session, thread);
  if (existing) {
    return finalizeAsRepeat(
      thread,
      session,
      existing,
      requestSummary,
      urgent,
    );
  }

  try {
    const customerId = createNewCustomer(
      thread.id,
      session.episode_id,
      name,
      phone,
      requestSummary,
      urgent,
    );
    return { kind: "created", customerId };
  } catch (error) {
    if (error instanceof Error && error.message === "NORMALIZED_MOBILE_ALREADY_EXISTS") {
      // BEGIN IMMEDIATE serializes mobile lookup and insert. This branch is a
      // defensive re-read for imports that bypassed the normal integrity guard.
      const raced = findCustomerByMobile(phone);
      if (raced) {
        return finalizeAsRepeat(thread, session, raced, requestSummary, urgent);
      }
    }
    setAllocationRetry(session, error);
    logger.warn(
      { threadId: thread.id, sourceMessageId: inbound.mid, error: error instanceof Error ? error.message : "unknown" },
      "Instagram CRM registration deferred for durable retry",
    );
    return { kind: "error" };
  }
}

/**
 * Called only for a newly accepted inbound event. No historical thread scan is
 * performed; a durable unique source-message key makes retries idempotent.
 */
export function processInstagramCrmRegistration(
  threadId: number,
  sourceMessageId: string,
): InstagramCrmRegistrationResult {
  try {
    const previousEvent = sessionBySource(sourceMessageId);
      if (previousEvent) {
        return {
          kind: "existing_session",
          ...(previousEvent.customer_id == null ? {} : { customerId: Number(previousEvent.customer_id) }),
          ...(previousEvent.state === REQUEST_WAIT && !previousEvent.question_delivered_at ? {
            needsRequestQuestion: true,
            question: REPEAT_QUESTION,
          } : {}),
        };
      }
      const inbound = getInbound(threadId, sourceMessageId);
      const thread = findThread(threadId);
      if (!inbound || !thread) return { kind: "error" };
      const name = validFullName(thread.full_name ?? thread.name);
      const phone = validIranianMobile(thread.phone);
      const currentText = normalizeText(inbound.content);
      const identityCapturedThisMessage = Boolean(
        (phone && validIranianMobile(inbound.content)) ||
        (name && currentText.includes(name)),
      );
      const urgent = isUrgentIntent(inbound.content);
      let latest = latestSession(threadId);
      const cleanedCurrent = cleanUserRequest(
        inbound.content,
        name,
        latest?.state === REQUEST_WAIT,
      );
      const summary = cleanedCurrent;
      const now = new Date().toISOString();

      if (
        latest &&
        [FIELD_WAIT, REGISTRATION_RETRY, REQUEST_WAIT].includes(latest.state)
      ) {
        const continued = continueSessionWithInbound(
          thread,
          latest,
          sourceMessageId,
          name,
          phone,
          summary,
          urgent,
          inbound,
        );
        if (latest.state === REQUEST_WAIT) {
          if (cleanedCurrent) {
            const customerId = Number(latest.customer_id);
            const requestName = latest.name_snapshot ?? name ?? thread.name ?? "کاربر اینستاگرام";
            runImmediateTransaction(() => {
              insertRepeatRequest({
                customerId,
                requestedName: requestName,
                summary: cleanedCurrent,
                threadId,
                sourceMessageId,
                createdAt: inbound.sent_at,
              });
              finishSessionEpisode(threadId, latest.episode_id, "completed_repeat", customerId);
              markUrgent(customerId, urgent || latest.is_urgent === 1);
            });
            return { kind: "repeat", customerId };
          }
          return {
            kind: "existing_session",
            ...(continued.customer_id == null ? {} : { customerId: Number(continued.customer_id) }),
          };
        }
        if (latest.state === REGISTRATION_RETRY || latest.state === FIELD_WAIT) {
          return registrationForSession(thread, continued, inbound, urgent);
        }
      }

      const existingLinkedId = thread.customer_id == null
        ? null
        : resolveCanonicalCustomerId(Number(thread.customer_id));
      const existingByPhone = phone ? findCustomerByMobile(phone) : undefined;
      const idleAt = priorInboundAt(threadId, sourceMessageId);
      const idleHours = idleAt
        ? (new Date(inbound.sent_at).getTime() - new Date(idleAt).getTime()) / (60 * 60 * 1000)
        : Number.POSITIVE_INFINITY;
      const meaningfulIntent = Boolean(cleanedCurrent);
      const qualifiesRepeat = (existingLinkedId != null || existingByPhone != null) &&
        (hasExplicitLoanIntent(inbound.content) ||
          (meaningfulIntent && idleHours >= 24) ||
          identityCapturedThisMessage);

      if (existingLinkedId != null || existingByPhone) {
        if (!qualifiesRepeat) {
          recordIgnoredEvent(threadId, sourceMessageId, now);
          return { kind: "waiting_fields" };
        }
        const customerId = existingLinkedId ?? existingByPhone!.id;
        const customer = queryRow<{ id: number; name: string }>(
          "SELECT id,name FROM customers WHERE id=?",
          [customerId],
        );
        if (!customer) return { kind: "error" };
        const eventState = "repeat_draft";
        const session = createEpisodeRow({
          threadId,
          sourceMessageId,
          name,
          phone,
          summary: meaningfulIntent ? cleanedCurrent : null,
          urgent,
          state: eventState,
          now,
        });
        return finalizeAsRepeat(
          thread,
          session,
          customer,
          meaningfulIntent ? cleanedCurrent : null,
          urgent,
        );
      }

      if (!identityCapturedThisMessage && !meaningfulIntent && !urgent) {
        recordIgnoredEvent(threadId, sourceMessageId, now);
        return { kind: "waiting_fields" };
      }

      const session = createEpisodeRow({
        threadId,
        sourceMessageId,
        name,
        phone,
        summary,
        urgent,
        state: FIELD_WAIT,
        now,
      });
      return registrationForSession(thread, session, inbound, urgent);
  } catch (error) {
    logger.error(
      { threadId, sourceMessageId, error: error instanceof Error ? error.message : "unknown" },
      "Instagram CRM registration service failed",
    );
    return { kind: "error" };
  }
}

/**
 * Handoff delivery is recorded once. Before delivery the receipt-time due date
 * remains authoritative; a confirmed send/Flow claim can move it one time.
 */
export function markInstagramCrmQuestionDelivered(threadId: number): void {
  const session = latestSession(threadId);
  if (!session || session.state !== REQUEST_WAIT || session.delivery_reset === 1) return;
  const now = new Date();
  executeChanges(
    `UPDATE instagram_crm_automation_sessions
     SET question_delivered_at=?,delivery_reset=1,due_at=?,updated_at=?
     WHERE id=? AND state=? AND delivery_reset=0`,
    [
      now.toISOString(),
      new Date(now.getTime() + THIRTY_MINUTES_MS).toISOString(),
      now.toISOString(),
      session.id,
      REQUEST_WAIT,
    ],
  );
}

/**
 * Finalizes only a real, accepted inbound message tied to the awaiting session.
 * Salutations, phone/name-only messages, acknowledgements, and CRM-membership
 * questions are not accepted as the requested repeat-request text.
 */
export function completeInstagramCrmRequestFromInbound(
  threadId: number,
  sourceMessageId: string,
  requestText?: string,
): void {
  try {
    completeRequestForSource(threadId, sourceMessageId, requestText);
  } catch (error) {
    logger.warn(
      { threadId, sourceMessageId, error: error instanceof Error ? error.message : "unknown" },
      "Instagram CRM repeat-request reply was not finalized",
    );
  }
}

/**
 * Avoids membership disclosure while a request question is pending and for
 * direct questions asking whether this Instagram sender is already in the CRM.
 */
export function getInstagramCrmReplyOverride(threadId: number): InstagramCrmReplyOverride | null {
  const inbound = queryRow<{ content: string }>(
    `SELECT content FROM instagram_messages
     WHERE thread_id=? AND direction='inbound' ORDER BY id DESC LIMIT 1`,
    [threadId],
  );
  if (!inbound) return null;
  const latest = latestSession(threadId);
  if (latest?.state === REQUEST_WAIT) {
    if (latest.source_message_id === latest.episode_id) {
      return { kind: "clarify", answer: REPEAT_QUESTION };
    }
    if (hasMembershipQuestion(inbound.content)) {
      return {
        kind: "redirect",
        answer: `برای حفظ حریم خصوصی، وضعیت ثبت یا پرونده از طریق دایرکت اعلام نمی‌شود. ${REPEAT_QUESTION}`,
      };
    }
    const summary = cleanUserRequest(inbound.content, latest.name_snapshot, true);
    if (summary) return null;
    return {
      kind: "clarify",
      answer: REPEAT_QUESTION,
    };
  }
  if (hasMembershipQuestion(inbound.content)) {
    return {
      kind: "redirect",
      answer: `برای حفظ حریم خصوصی، وضعیت ثبت یا پرونده از طریق دایرکت اعلام نمی‌شود. ${REPEAT_QUESTION}`,
    };
  }
  return null;
}

function retrySession(session: SessionRow, now: Date, error: unknown): void {
  const attempts = Number(session.attempts) + 1;
  const exhausted = attempts >= MAX_RETRIES;
  const timestamp = now.toISOString();
  executeChanges(
    `UPDATE instagram_crm_automation_sessions
     SET state=?,attempts=?,error=?,due_at=?,updated_at=?,finalized_at=?
     WHERE thread_id=? AND episode_id=? AND state=?`,
    [
      exhausted ? "needs_human" : REQUEST_WAIT,
      attempts,
      (error instanceof Error ? error.message : "AUTOMATION_DUE_FAILED").slice(0, 200),
      exhausted ? null : new Date(now.getTime() + RETRY_DELAY_MS).toISOString(),
      timestamp,
      exhausted ? timestamp : null,
      session.thread_id,
      session.episode_id,
      REQUEST_WAIT,
    ],
  );
  if (exhausted) {
    logger.warn(
      { threadId: session.thread_id, error: session.error },
      "Instagram CRM fallback retry exhausted; draft retained for human review",
    );
  }
}

/**
 * Durable restart-safe worker. A due draft is finalized from inbound user text
 * only; if no meaningful summary exists it is retained as needs_human, rather
 * than inventing request content or leaving an endlessly due job.
 */
export async function processInstagramCrmAutomationDue(now = new Date()): Promise<void> {
  const dueAt = now.toISOString();
  const dueSessions = queryRows<SessionRow>(
    `SELECT s.* FROM instagram_crm_automation_sessions s
     WHERE s.state IN (?,?) AND s.due_at IS NOT NULL AND s.due_at<=?
       AND s.id=(SELECT MAX(latest.id) FROM instagram_crm_automation_sessions latest
         WHERE latest.thread_id=s.thread_id AND latest.episode_id=s.episode_id)
     ORDER BY s.due_at,s.id`,
    [REQUEST_WAIT, REGISTRATION_RETRY, dueAt],
  );
  for (const session of dueSessions) {
    if (session.state === REGISTRATION_RETRY) {
      try {
        const thread = findThread(session.thread_id);
        if (!thread) {
          finishSessionEpisode(session.thread_id, session.episode_id, "needs_human", null, "thread_missing");
          continue;
        }
        const name = session.name_snapshot;
        const phone = session.phone_snapshot;
        if (!name || !phone) {
          finishSessionEpisode(session.thread_id, session.episode_id, "needs_human", null, "identity_fields_missing");
          continue;
        }
        const existing = findCustomerByMobile(phone);
        if (existing) {
          finalizeAsRepeat(
            thread,
            session,
            existing,
            session.request_summary,
            session.is_urgent === 1,
          );
          continue;
        }
        createNewCustomer(
          session.thread_id,
          session.episode_id,
          name,
          phone,
          session.request_summary,
          session.is_urgent === 1,
        );
      } catch (error) {
        setAllocationRetry(session, error, now);
      }
      continue;
    }
    try {
      const thread = findThread(session.thread_id);
      if (!thread || !session.customer_id) {
        finishSessionEpisode(session.thread_id, session.episode_id, "needs_human", session.customer_id, "repeat_draft_incomplete");
        continue;
      }
      const summary = getEpisodeRequestSummary(session, thread);
      if (!summary) {
        finishSessionEpisode(
          session.thread_id,
          session.episode_id,
          "needs_human",
          session.customer_id,
          "no_meaningful_user_summary",
        );
        continue;
      }
      const source = queryRow<{ source_message_id: string }>(
        `SELECT source_message_id FROM instagram_crm_automation_sessions
         WHERE thread_id=? AND episode_id=? ORDER BY id LIMIT 1`,
        [session.thread_id, session.episode_id],
      );
      if (!source) throw new Error("AUTOMATION_SOURCE_EVENT_MISSING");
      const customer = queryRow<{ id: number; name: string }>(
        "SELECT id,name FROM customers WHERE id=?",
        [session.customer_id],
      );
      if (!customer) {
        finishSessionEpisode(session.thread_id, session.episode_id, "needs_human", session.customer_id, "customer_missing");
        continue;
      }
      const created = finalizeRepeatEpisode({
        threadId: session.thread_id,
        episodeId: session.episode_id,
        customerId: customer.id,
        name: session.name_snapshot ?? customer.name,
        summary,
        sourceMessageId: source.source_message_id,
        urgent: session.is_urgent === 1,
        createdAt: dueAt,
        amountQuestionAsked: true,
      });
      if (!created) {
        finishSessionEpisode(session.thread_id, session.episode_id, "needs_human", customer.id, "no_meaningful_user_summary");
      }
    } catch (error) {
      retrySession(session, now, error);
    }
  }
}