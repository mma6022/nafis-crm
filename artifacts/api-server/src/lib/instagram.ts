import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { execute, executeChanges, queryRow, queryRows, runTransaction } from "./crm-db";
import { logger } from "./logger";
import { instagramBoundAccountId, instagramStoredCredentials } from "./instagram-oauth";
import { manychatConfig, sendManychatReply, type ManychatReplyMode } from "./manychat";
import {
  exactInstagramGreetingReply,
  instagramAdviceSystemPrompt,
  prepareInstagramAdvice,
  instagramAiFailureCode,
  type InstagramAiAdvice,
} from "./instagram-ai-advice";
import {
  projectInstagramPublicPlans,
  type InstagramPublicPlanSource,
} from "./instagram-public-plans";
import {
  extractInstagramIntakeIdentity,
  extractInstagramIntakeIdentityDeterministically,
  instagramIntakeRequestText,
  normalizeInstagramPhone,
  type InstagramIntakeMessage,
} from "./instagram-intake-identity";
export { normalizeInstagramPhone };
import {
  completeInstagramCrmRequestFromInbound,
  getInstagramCrmReplyOverride,
  markInstagramCrmQuestionDelivered,
  processInstagramCrmAutomationDue,
  processInstagramCrmRegistration,
} from "./instagram-crm-automation";

type InstagramThread = {
  id: number;
  sender_id: string;
  name: string | null;
  phone: string | null;
  request: string | null;
  customer_id: number | null;
  requested_field: RequestedField | null;
  paused: number;
  last_message_at: string | null;
  last_reply_at: string | null;
};

type RequestedField = "name" | "phone" | "request";
type PreparedInstagramReply = {
  reply: string;
  replies: string[];
  requestedField: RequestedField | null;
  crmQuestion: boolean;
};

const normalizeDigits = (value: string) =>
  value.replace(/[۰-۹]/g, (digit) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit)))
    .replace(/[٠-٩]/g, (digit) => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)));
const PHONE_PATTERN =
  /(?<!\d)(?:(?:0098|\+?98)[\s().-]*)?(?:0[\s().-]*)?9(?:[\s().-]*\d){9}(?![\s().-]*\d)/g;

export const instagramConfig = () => {
  const credentials = instagramStoredCredentials();
  const accountId = instagramBoundAccountId();
  return {
    appSecret: process.env.IG_APP_SECRET ?? "",
    verifyToken: process.env.IG_VERIFY_TOKEN ?? "",
    accessToken: credentials.accessToken,
    accountId,
    accountUsername: credentials.accountUsername,
    tokenExpiry: credentials.tokenExpiry,
    connected: credentials.connected,
    configured: Boolean(
      process.env.IG_APP_SECRET &&
        process.env.IG_VERIFY_TOKEN &&
        accountId,
    ),
    enabled:
      process.env.IG_AUTOREPLY_ENABLED === "1" &&
      credentials.usable &&
      Boolean(credentials.accessToken) &&
      credentials.accountId === accountId,
  };
};

export function verifyInstagramSignature(body: Buffer, signature: string | undefined): boolean {
  const secret = process.env.IG_APP_SECRET;
  if (!secret || !signature || !/^sha256=[0-9a-f]{64}$/i.test(signature)) return false;
  const expected = createHmac("sha256", secret).update(body).digest();
  const supplied = Buffer.from(signature.slice(7), "hex");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

const NAME_PATTERNS = [
  /(?:^|[\s،,])من\s+([\p{L}‌]+(?:\s+[\p{L}‌]+){0,3}?)\s+(?:هستم|ام)(?=[\s،,.!?؟]|$)/giu,
  /(?:^|[\s،,])(?:اسمم|نامم)\s+([\p{L}‌]+(?:\s+[\p{L}‌]+){0,3}?)(?=\s+(?:است|هست|می‌باشد|میباشد|هستم)|[،,.!?؟]|$)/giu,
  /(?:^|[\s،,])(?:اسم|نام)\s+من\s+([\p{L}‌]+(?:\s+[\p{L}‌]+){0,3}?)(?=\s+(?:است|هست|می‌باشد|میباشد|هستم)|[،,.!?؟]|$)/giu,
];

const NON_NAME_WORDS = new Set([
  "دنبال", "وام", "تسهیلات", "قرض", "متقاضی", "درخواست", "مشتری", "نیازمند",
  "مشاوره", "راهنمایی", "شرایط", "مبلغ", "قسط", "اقساط", "هستم", "هست", "میخواهم",
  "میخوام", "می‌خواهم", "می‌خوام", "خوب", "سلام", "شماره", "موبایل",
  "است", "هست", "می‌باشد", "میباشد", "نام", "اسم", "من",
  "برای", "دنبال", "نیاز", "ممنون", "مرسی", "باشه", "اوکی", "بله",
  "لطفا", "لطفاً", "میخواستم", "خواستم", "بپرسم",
  "خرید", "پرداخت", "دریافت",
  "دارم", "دارد", "میشه", "می‌شه", "میتونم", "می‌توانم", "درباره",
  "امکان", "موجود", "اطلاعات", "بیشتر", "برام", "چی", "چطور",
  "چگونه", "چقدر", "چند", "سوال", "سؤال", "وام", "تسهیلات",
  "قرض", "لوازم", "منزل", "ماشین", "کالا", "خودرو", "می‌خواهم",
  "قیمت", "لپتاپ", "لپ‌تاپ", "مبلغ", "هزینه", "محصول", "سرویس",
  "را", "اصلاح", "تصحیح", "تغییر", "کنید", "کردم", "کرده", "درست",
]);

function normalizePersonText(value: string): string {
  return value.normalize("NFC").replace(/[يى]/g, "ی").replace(/ك/g, "ک")
    .replace(/\u200c/g, " ").replace(/\s+/g, " ").trim();
}

function nameFromCandidate(candidate: string): string | null {
  const cleaned = normalizePersonText(candidate);
  const words = cleaned.split(" ");
  if (
    cleaned.length > 100 ||
    words.length < 2 ||
    words.length > 4 ||
    words.some((word) =>
      word.length < 2 ||
      NON_NAME_WORDS.has(word.toLocaleLowerCase()) ||
      !/^[\p{L}‌-]+$/u.test(word),
    )
  ) return null;
  return cleaned;
}

const GREETING_PREFIX = /^(?:(?:سلام(?:\s+و\s+وقت\s+بخیر)?|درود|وقت\s+بخیر|خسته\s+نباشید)[،،\s]*)+/iu;
const OTP_NOISE = /(?:\bOTP\b|رمز\s*(?:یکبار\s*مصرف|ورود|تایید)|کد\s*(?:تایید|ورود|اعتبارسنجی))/iu;
const CORRECTED_NAME_PATTERNS = [
  /(?:نام|اسم)(?:م)?(?:\s+و\s+نام\s+خانوادگی)?(?:\s+من)?\s*(?:را\s*)?(?:به|[:：])\s*([\p{L}‌]+(?:[\s‌-]+[\p{L}‌]+){1,3}?)(?=\s*(?:اصلاح|تصحیح|تغییر|کنید|کردم|شده|است|هست)|[،,.!?؟؛;]|$)/giu,
  /(?:اصلاح|تصحیح)\s+(?:نام|اسم)(?:م)?(?:\s*(?:به|[:：]))?\s*([\p{L}‌]+(?:[\s‌-]+[\p{L}‌]+){1,3}?)(?=\s*(?:اصلاح|تصحیح|تغییر|کنید|کردم|شده|است|هست)|[،,.!?؟؛;]|$)/giu,
];

function parseName(text: string, allowPlainFullName = false): string | null {
  const normalized = normalizePersonText(text);
  if (OTP_NOISE.test(normalized) ||
    /(?:ضامن|پدرم|مادرم|همسرم|شوهرم|خانمم|برادرم|خواهرم|دوستم|همکارم|ایشان|ایشون|prompt|پرامپت|دستور)/iu.test(normalized) ||
    /["“”«»‘’'`]/u.test(normalized)) return null;
  for (const pattern of [...CORRECTED_NAME_PATTERNS, ...NAME_PATTERNS]) {
    pattern.lastIndex = 0;
    const candidate = pattern.exec(normalized)?.[1];
    if (candidate) {
      const name = nameFromCandidate(candidate);
      if (name) return name;
    }
  }
  if (!allowPlainFullName) return null;
  const plain = normalized.replace(GREETING_PREFIX, "").trim()
    .replace(/[.!،,؛;:؟?]+$/g, "").replace(/\s+/g, " ");
  return nameFromCandidate(plain);
}

function parseCorrectedName(text: string): string | null {
  const normalized = normalizePersonText(text);
  for (const pattern of CORRECTED_NAME_PATTERNS) {
    pattern.lastIndex = 0;
    const candidate = pattern.exec(normalized)?.[1];
    if (candidate) {
      const name = nameFromCandidate(candidate);
      if (name) return name;
    }
  }
  return null;
}

function namePattern(name: string): RegExp | null {
  const tokens = normalizePersonText(name).split(/[\s-]+/).filter(Boolean);
  if (tokens.length < 2 || tokens.length > 4) return null;
  const escapedTokens = tokens.map((token) => [...token].map((character) => {
    if (character === "ی") return "[یيى]";
    if (character === "ک") return "[کك]";
    return character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }).join(""));
  return new RegExp(`(?<![\\p{L}])${escapedTokens.join("[\\s‌-]+")}(?![\\p{L}])`, "giu");
}

function redactConversationNames(content: string, knownName: string | null, plainNameWasRequested: boolean): string {
  let redacted = content;
  const names = new Set<string>();
  if (knownName) names.add(knownName);
  for (const pattern of [...NAME_PATTERNS, ...CORRECTED_NAME_PATTERNS]) {
    const matcher = new RegExp(pattern.source, "giu");
    for (const match of redacted.matchAll(matcher)) {
      const candidate = nameFromCandidate(match[1] ?? "");
      if (candidate) names.add(candidate);
    }
  }
  if (plainNameWasRequested) {
    const candidate = parseName(redacted, true);
    if (candidate) names.add(candidate);
  }
  for (const name of names) {
    const pattern = namePattern(name);
    if (pattern) redacted = redacted.replace(pattern, "[نام حذف شد]");
  }
  return redacted;
}

function updateLead(threadId: number, _mid: string, incomingText: string): void {
  const thread = queryRow<InstagramThread>("SELECT * FROM instagram_threads WHERE id=?", [threadId]);
  if (!thread) return;
  const messages = queryRows<InstagramIntakeMessage & { id: number }>(
    `SELECT mid,content,sent_at AS sentAt,id FROM instagram_messages
      WHERE thread_id=? AND direction='inbound' ORDER BY id DESC LIMIT 60`,
    [threadId],
  ).reverse();
  const extracted = extractInstagramIntakeIdentityDeterministically(messages, {
    currentName: thread.name,
    currentPhone: thread.phone,
    requestedField: thread.requested_field,
  });
  if (extracted.nameMessageIds.length) {
    executeChanges(
      `UPDATE instagram_messages SET sensitive_name=1
        WHERE thread_id=? AND mid IN (${extracted.nameMessageIds.map(() => "?").join(",")})`,
      [threadId, ...extracted.nameMessageIds],
    );
  }
  const name = thread.name && !extracted.correctedName ? thread.name : extracted.name;
  const phone = thread.phone ?? extracted.phone;
  const request = instagramIntakeRequestText(incomingText, name ?? thread.name) ?? thread.request;
  const capturedRequestedField =
    (thread.requested_field === "name" && Boolean(name)) ||
    (thread.requested_field === "phone" && Boolean(phone));
  executeChanges(
    `UPDATE instagram_threads
        SET name=?,phone=?,request=?,requested_field=?,is_urgent=CASE WHEN is_urgent=1 OR ?=1 THEN 1 ELSE 0 END,
            updated_at=? WHERE id=?`,
    [name, phone, request, capturedRequestedField ? null : thread.requested_field,
      extracted.urgent ? 1 : 0, new Date().toISOString(), threadId],
  );
}

function observeInstagramCrmOperation(operation: () => unknown, component: string): void {
  try {
    void Promise.resolve(operation()).catch(() => {
      logger.warn({ component, reason: "crm_automation_operation_failed" },
        "Instagram CRM automation operation failed");
    });
  } catch {
    logger.warn({ component, reason: "crm_automation_operation_failed" },
      "Instagram CRM automation operation failed");
  }
}

function processAcceptedInstagramInbound(
  threadId: number,
  sourceMessageId: string,
  text: string,
): void {
  const thread = queryRow<InstagramThread>("SELECT * FROM instagram_threads WHERE id=?", [threadId]);
  if (!thread) return;
  const requestText = instagramIntakeRequestText(text, thread.name);
  observeInstagramCrmOperation(
    () => completeInstagramCrmRequestFromInbound(threadId, sourceMessageId, requestText ?? undefined),
    "instagram-crm-request",
  );
  // This is intentionally after acceptInstagramMessage's raw-capture transaction:
  // the CRM service owns its own atomic registration and duplicate handling.
  observeInstagramCrmOperation(
    () => processInstagramCrmRegistration(threadId, sourceMessageId),
    "instagram-crm-registration",
  );
}

export function acceptInstagramMessage(input: {
  senderId: string;
  recipientId: string;
  mid: string;
  text: string;
  timestamp?: number;
  source?: "manychat";
}): "accepted" | "ignored" | "duplicate" {
  const config = instagramConfig();
  const manychat = manychatConfig();
  const boundAccountId = input.source === "manychat" ? manychat.recipientId : config.accountId;
  const validProvider = input.source === "manychat"
    ? manychat.configured && input.senderId.startsWith(`mc:${manychat.accountId}:`)
    : Boolean(config.accountId);
  // The account binding survives disconnect; signed inbound events remain storable,
  // while the missing/expired token keeps outbound automation disabled.
  if (
    !validProvider ||
    !input.senderId ||
    input.senderId === boundAccountId ||
    input.recipientId !== boundAccountId ||
    !input.mid ||
    typeof input.text !== "string" ||
    !input.text.trim()
  ) return "ignored";

  const suppliedTimestamp = Number.isFinite(input.timestamp) ? new Date(Number(input.timestamp)) : null;
  const sentAt = suppliedTimestamp && Number.isFinite(suppliedTimestamp.getTime())
    ? suppliedTimestamp.toISOString()
    : new Date().toISOString();
  const now = new Date().toISOString();
  try {
    let acceptedThreadId: number | null = null;
    const result: "accepted" = runTransaction(() => {
      let thread = queryRow<InstagramThread>("SELECT * FROM instagram_threads WHERE sender_id=?", [input.senderId]);
      if (!thread) {
        const id = execute(
          `INSERT INTO instagram_threads (sender_id, status, last_message_at, created_at, updated_at)
           VALUES (?, 'open', ?, ?, ?)`,
          [input.senderId, sentAt, now, now],
        );
        thread = queryRow<InstagramThread>("SELECT * FROM instagram_threads WHERE id=?", [id]);
      }
      if (!thread) throw new Error("INSTAGRAM_THREAD_INSERT_FAILED");
      execute(
        "INSERT INTO instagram_messages (thread_id, mid, direction, content, sent_at) VALUES (?, ?, 'inbound', ?, ?)",
        [thread.id, input.mid, input.text.slice(0, 10000), sentAt],
      );
      executeChanges(
        `UPDATE instagram_threads
           SET last_message_at=CASE WHEN last_message_at IS NULL OR last_message_at < ? THEN ? ELSE last_message_at END,
               error=NULL, updated_at=? WHERE id=?`,
        [sentAt, sentAt, now, thread.id],
      );
      updateLead(thread.id, input.mid, input.text);
      acceptedThreadId = thread.id;
      if (input.source === "manychat" && manychat.mode === "flow") {
        const previous = queryRow<{ received_at: string }>(
          "SELECT received_at FROM instagram_flow_replies WHERE thread_id=?",
          [thread.id],
        );
        // Manychat Custom User Fields are contact-wide, not Flow-run-local.
        // Two delayed Flows for one contact can overwrite each other's fields.
        // Fail closed for overlapping runs instead of handing the newer reply
        // to an older Flow. A later DM outside this guard can be automated.
        const overlapping = manychat.enabled && previous &&
          Date.now() - new Date(previous.received_at).getTime() < 120_000;
        // A newer message invalidates any prepared answer to an older message,
        // even while automation is off or the conversation is paused.
        executeChanges(
          "UPDATE instagram_flow_replies SET state='failed', revision=revision+1, reply_text=NULL, reply_messages_json=NULL, next_item_index=0, requested_field=NULL, error='newer_message', updated_at=? WHERE thread_id=? AND state IN ('pending','processing','ready')",
          [now, thread.id],
        );
        {
          const canReply = manychat.enabled && !thread.paused && !overlapping;
          execute(
            `INSERT INTO instagram_flow_replies
               (thread_id, account_id, request_id, revision, state, received_at, updated_at, error)
             VALUES (?, ?, ?, 1, ?, ?, ?, ?)
             ON CONFLICT(thread_id) DO UPDATE SET account_id=excluded.account_id,
               request_id=excluded.request_id, revision=instagram_flow_replies.revision+1,
                state=excluded.state, reply_text=NULL, reply_messages_json=NULL, next_item_index=0,
                requested_field=NULL, received_at=excluded.received_at,
               updated_at=excluded.updated_at, lease_expires_at=NULL, error=excluded.error`,
            [thread.id, manychat.accountId, instagramFlowRequestId(input.mid),
              canReply ? "pending" : "failed", sentAt, now,
              "identity_pending"],
          );
          if (overlapping) setThreadFailure(thread.id, "overlapping_messages");
        }
      }
      // The former Meta-app sender is retired; signed legacy events can still
      // be archived, but only Manychat events may schedule outbound messages.
      if (input.source === "manychat" && manychat.mode === "api") {
        const newestInbound = queryRow<{ last_message_at: string }>(
          "SELECT last_message_at FROM instagram_threads WHERE id=?",
          [thread.id],
        )?.last_message_at ?? sentAt;
        const canReply = manychat.enabled && !thread.paused;
        execute(
          `INSERT INTO instagram_send_queue (thread_id, state, due_at, created_at, updated_at, error)
           VALUES (?, ?, ?, ?, ?, 'identity_pending')
           ON CONFLICT(thread_id) DO UPDATE SET
               state=excluded.state, revision=instagram_send_queue.revision+1, requested_field=NULL,
              reply_messages_json=NULL, next_message_index=0,
              due_at=excluded.due_at, updated_at=excluded.updated_at, error='identity_pending'`,
          [thread.id, canReply ? "pending" : "failed",
            new Date(new Date(newestInbound).getTime() + 10_000).toISOString(), now, now],
        );
      }
      return "accepted";
    });
    if (result === "accepted" && input.source === "manychat" && acceptedThreadId != null) {
      processAcceptedInstagramInbound(acceptedThreadId, input.mid, input.text);
    }
    return result;
  } catch (error) {
    if (error instanceof Error && error.message.includes("UNIQUE constraint failed: instagram_messages.mid")) {
      return "duplicate";
    }
    throw error;
  }
}

export function instagramFlowRequestId(mid: string): string {
  return createHash("sha256").update(mid).digest("hex").slice(0, 32);
}

function missingRequestedField(thread: InstagramThread): RequestedField | null {
  if (!thread.name) return "name";
  if (!thread.phone) return "phone";
  return null;
}

function requestedFieldPrompt(field: RequestedField): string {
  if (field === "name") return "برای تکمیل ثبت، لطفاً نام و نام خانوادگی‌تان را بفرمایید.";
  if (field === "phone") return "برای تکمیل ثبت، لطفاً شماره موبایل ۱۱ رقمی‌تان را بفرمایید.";
  return "برای تکمیل ثبت، لطفاً موضوع درخواست‌تان را در یک جمله بفرمایید.";
}

function validateFinalReply(reply: string): string {
  if (!reply.trim() || Buffer.byteLength(reply, "utf8") > 900) {
    throw new Error("AI_RESPONSE_TOO_LARGE");
  }
  return reply;
}

function validateReplyMessages(reply: string, additional: string[] = []): string[] {
  const messages = [reply, ...additional];
  if (messages.length > 10) throw new Error("AI_RESPONSE_TOO_MANY_MESSAGES");
  return messages.map((message) => validateFinalReply(message));
}

async function prepareReply(threadId: number, replyMode: ManychatReplyMode): Promise<PreparedInstagramReply> {
  const thread = queryRow<InstagramThread>("SELECT * FROM instagram_threads WHERE id=?", [threadId]);
  if (!thread) throw new Error("thread_missing");
  const crmOverride = getInstagramCrmReplyOverride(threadId);
  if (crmOverride) {
    return {
      reply: validateFinalReply(crmOverride.answer),
      replies: [validateFinalReply(crmOverride.answer)],
      requestedField: "request",
      crmQuestion: true,
    };
  }
  const requestedField = missingRequestedField(thread);
  if (replyMode === "intake") {
    if (requestedField) return {
      reply: validateFinalReply(requestedFieldPrompt(requestedField)),
      replies: [validateFinalReply(requestedFieldPrompt(requestedField))],
      requestedField,
      crmQuestion: false,
    };
    return {
      reply: validateFinalReply("ممنون، پیام شما دریافت شد. درباره نام طرح یا پرسش‌تان راهنمایی‌تان می‌کنم."),
      replies: [validateFinalReply("ممنون، پیام شما دریافت شد. درباره نام طرح یا پرسش‌تان راهنمایی‌تان می‌کنم.")],
      requestedField: null,
      crmQuestion: false,
    };
  }
  let advice: InstagramAiAdvice;
  try {
    advice = await aiReply(threadId, "");
  } catch (error) {
    const reason = instagramAiFailureCode(error);
    logger.warn(
      { component: "instagram-ai", outcome: "service_fallback", reason },
      "Instagram AI unavailable; prepared safe loan-guidance fallback",
    );
    return {
      reply: validateFinalReply(
        "فعلاً امکان بررسی شرایط وام را ندارم. اگر درباره مبلغ، طرح یا شرایط وام پرسشی دارید، لطفاً همان را بفرمایید.",
      ),
      replies: [validateFinalReply(
        "فعلاً امکان بررسی شرایط وام را ندارم. اگر درباره مبلغ، طرح یا شرایط وام پرسشی دارید، لطفاً همان را بفرمایید.",
      )],
      requestedField: null,
      crmQuestion: false,
    };
  }
  const answer = validateFinalReply(advice.answer);
  const additional = (advice as InstagramAiAdvice & { messages?: unknown }).messages;
  if (additional !== undefined &&
    (!Array.isArray(additional) || additional.some((message) => typeof message !== "string"))) {
    throw new Error("AI_RESPONSE_INVALID_MESSAGES");
  }
  const replies = validateReplyMessages(answer, (additional ?? []) as string[]);
  return {
    reply: replies[0],
    replies,
    requestedField: null,
    crmQuestion: false,
  };
}

function publicLoanPlans() {
  const plans = queryRows<{
    id: number;
    name: string;
    principal_amount: string | null;
    installment_terms: string | null;
    deposit_percents: string | null;
    required_documents: string | null;
    installments: string | null;
    active: number | null;
    needs_guarantor: number | null;
    needs_customer_promissory: number | null;
    needs_guarantor_promissory: number | null;
    needs_customer_check: number | null;
    needs_guarantor_check: number | null;
    needs_customer_salary_deduct: number | null;
    needs_guarantor_salary_deduct: number | null;
    customer_check: string | null;
    guarantor_check: string | null;
    collateral_type: string | null;
    guarantor_collateral_type: string | null;
  }>(
    `SELECT id,name,principal_amount,installment_terms,deposit_percents,required_documents,
            installments,active,needs_guarantor,needs_customer_promissory,
            needs_guarantor_promissory,needs_customer_check,needs_guarantor_check,
            needs_customer_salary_deduct,needs_guarantor_salary_deduct,
            customer_check,guarantor_check,collateral_type,guarantor_collateral_type
       FROM loan_plans WHERE COALESCE(active, 1)=1 ORDER BY id LIMIT 100`,
  );
  type ConditionCandidate = {
    maxPrincipal: string | null;
    customerRanks: string | null;
    installmentOptions: string | null;
    customerJobs: string | null;
    collateralType: string | null;
    needsGuarantor: number | null;
    guarantorRanks: string | null;
    guarantorJobs: string | null;
    guarantorCollateralType: string | null;
    needsCustomerPromissory: number | null;
    needsGuarantorPromissory: number | null;
    needsCustomerSalaryDeduct: number | null;
    needsGuarantorSalaryDeduct: number | null;
    needsCustomerCheck: number | null;
    needsGuarantorCheck: number | null;
  };
  const conditionsByPlan = new Map<number, ConditionCandidate[]>();
  if (plans.length) {
    const conditions = queryRows<{
      plan_id: number;
      max_principal: string | null;
      customer_ranks: string | null;
      installment_options: string | null;
      customer_jobs: string | null;
      collateral_type: string | null;
      needs_guarantor: number | null;
      guarantor_ranks: string | null;
      guarantor_jobs: string | null;
      guarantor_collateral_type: string | null;
      needs_customer_promissory: number | null;
      needs_guarantor_promissory: number | null;
      needs_customer_salary_deduct: number | null;
      needs_guarantor_salary_deduct: number | null;
      needs_customer_check: number | null;
      needs_guarantor_check: number | null;
    }>(
      `SELECT plan_id,max_principal,customer_ranks,installment_options,customer_jobs,
              collateral_type,needs_guarantor,guarantor_ranks,guarantor_jobs,
              guarantor_collateral_type,needs_customer_promissory,
              needs_guarantor_promissory,needs_customer_salary_deduct,
              needs_guarantor_salary_deduct,needs_customer_check,needs_guarantor_check
         FROM loan_plan_conditions
        WHERE plan_id IN (${plans.map(() => "?").join(",")})
        ORDER BY plan_id,sort_order,id`,
      plans.map((plan) => plan.id),
    );
    for (const condition of conditions) {
      const candidates = conditionsByPlan.get(condition.plan_id) ?? [];
      candidates.push({
        maxPrincipal: condition.max_principal,
        customerRanks: condition.customer_ranks,
        installmentOptions: condition.installment_options,
        customerJobs: condition.customer_jobs,
        collateralType: condition.collateral_type,
        needsGuarantor: condition.needs_guarantor,
        guarantorRanks: condition.guarantor_ranks,
        guarantorJobs: condition.guarantor_jobs,
        guarantorCollateralType: condition.guarantor_collateral_type,
        needsCustomerPromissory: condition.needs_customer_promissory,
        needsGuarantorPromissory: condition.needs_guarantor_promissory,
        needsCustomerSalaryDeduct: condition.needs_customer_salary_deduct,
        needsGuarantorSalaryDeduct: condition.needs_guarantor_salary_deduct,
        needsCustomerCheck: condition.needs_customer_check,
        needsGuarantorCheck: condition.needs_guarantor_check,
      });
      conditionsByPlan.set(condition.plan_id, candidates);
    }
  }
  const documentLabels = queryRows<{ option_value: string; label_fa: string }>(
    `SELECT option_value, label_fa FROM consult_options
      WHERE field_key='required_document' AND active=1 LIMIT 200`,
  );
  const labels = new Map(documentLabels.map((item) => [item.option_value, item.label_fa]));
  const sources: Array<InstagramPublicPlanSource & {
    conditions: ConditionCandidate[];
  }> = plans.map((plan) => ({
    name: plan.name,
    principalAmount: plan.principal_amount,
    installmentTerms: plan.installment_terms,
    depositPercents: plan.deposit_percents,
    requiredDocuments: plan.required_documents,
    installments: plan.installments,
    active: plan.active,
    needsGuarantor: plan.needs_guarantor,
    needsCustomerPromissory: plan.needs_customer_promissory,
    needsGuarantorPromissory: plan.needs_guarantor_promissory,
    needsCustomerCheck: plan.needs_customer_check,
    needsGuarantorCheck: plan.needs_guarantor_check,
    needsCustomerSalaryDeduct: plan.needs_customer_salary_deduct,
    needsGuarantorSalaryDeduct: plan.needs_guarantor_salary_deduct,
    customerCheck: plan.customer_check,
    guarantorCheck: plan.guarantor_check,
    collateralType: plan.collateral_type,
    guarantorCollateralType: plan.guarantor_collateral_type,
    conditions: conditionsByPlan.get(plan.id) ?? [],
  }));
  return projectInstagramPublicPlans(sources, labels);
}

async function aiReply(threadId: number, suffix: string): Promise<InstagramAiAdvice> {
  const thread = queryRow<InstagramThread>("SELECT * FROM instagram_threads WHERE id=?", [threadId]);
  if (!thread) throw new Error("thread_missing");
  const latestInbound = queryRow<{ content: string }>(
    "SELECT content FROM instagram_messages WHERE thread_id=? AND direction='inbound' ORDER BY sent_at DESC, id DESC LIMIT 1",
    [threadId],
  );
  const greetingReply = latestInbound ? exactInstagramGreetingReply(latestInbound.content) : null;
  if (greetingReply) return greetingReply;
  const plans = publicLoanPlans();
  const messages = queryRows<{ direction: string; content: string; sensitive_name: number; sent_at: string; id: number }>(
    `SELECT direction, content, sensitive_name, sent_at, id FROM instagram_messages
      WHERE thread_id=? ORDER BY sent_at DESC, id DESC LIMIT 20`,
    [threadId],
  ).map((message) => ({
    ...message,
    content: message.sensitive_name ? "[نام حذف شد]" : message.content,
    source: "message" as const,
  }));
  const handoffs = queryRows<{ content: string; created_at: string; id: number }>(
    "SELECT content, created_at, id FROM instagram_flow_handoffs WHERE thread_id=? ORDER BY created_at DESC, id DESC LIMIT 10",
    [threadId],
  ).map((handoff) => ({ direction: "handoff", content: handoff.content, sent_at: handoff.created_at, id: handoff.id, source: "handoff" as const }));
  const handoffItems = queryRows<{ content: string; created_at: string; id: number }>(
    "SELECT content, created_at, id FROM instagram_flow_handoff_items WHERE thread_id=? ORDER BY created_at DESC, id DESC LIMIT 20",
    [threadId],
  ).map((handoff) => ({
    direction: "handoff",
    content: handoff.content,
    sent_at: handoff.created_at,
    id: handoff.id + 1_000_000_000,
    source: "handoff" as const,
  }));
  const latestMessages = [...messages, ...handoffs, ...handoffItems]
    .sort((a, b) => a.sent_at.localeCompare(b.sent_at) || a.id - b.id)
    .slice(-16);
  const phone = thread.phone?.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const exactPhone = phone ? new RegExp(phone, "g") : null;
  let plainNameWasRequested = false;
  const history = latestMessages.map((message) => {
    let content = normalizePersonText(normalizeDigits(message.content.slice(0, 1200)));
    content = redactConversationNames(content, thread.name, message.direction === "inbound" && plainNameWasRequested);
    if (message.direction === "inbound" && plainNameWasRequested) plainNameWasRequested = false;
    if (thread.phone && exactPhone) content = content.replace(exactPhone, "[شماره حذف شد]");
    PHONE_PATTERN.lastIndex = 0;
    content = content.replace(PHONE_PATTERN, "[شماره حذف شد]");
    if (message.direction !== "inbound" && content.includes("نام و نام خانوادگی")) {
      plainNameWasRequested = true;
    }
    return {
      role: message.direction === "inbound" ? "user" as const : "assistant" as const,
      content,
    };
  });
  if (!history.length) throw new Error("empty_thread_history");
  const planContext = JSON.stringify(plans).replace(/</g, "\\u003c");
  if (Buffer.byteLength(planContext, "utf8") > 48_000) {
    throw new Error("LOAN_PLAN_CONTEXT_TOO_LARGE");
  }
  const systemPrompt = instagramAdviceSystemPrompt(planContext);
  const configuredTimeout = Number(process.env.INSTAGRAM_AI_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout >= 100
    ? Math.min(configuredTimeout, 25_000) : 25_000;
  return prepareInstagramAdvice(
    [{ role: "system", content: systemPrompt }, ...history],
    { timeoutMs, suffix },
  );
}

let workerRunning = false;
let flowWorkerRunning = false;
let workerTimer: NodeJS.Timeout | undefined;
const SEND_LEASE_MS = 120_000;
const GLOBAL_SEND_SPACING_MS = 10_000;

type InstagramLease = {
  token: string;
  queueId: number;
  threadId: number;
  revision: number;
  senderId: string;
  lastMessageAt: string;
  lastInboundMid: string;
  accountId: string;
  replyMode: ManychatReplyMode;
  replyMessagesJson: string | null;
  nextMessageIndex: number;
  requestedField: RequestedField | null;
};

type SendState = {
  last_sent_at: string | null;
  lease_token: string | null;
  lease_expires_at: string | null;
  lease_queue_id: number | null;
  lease_revision: number | null;
  lease_stage: "processing" | "sending" | null;
};

function clearLease(token: string): number {
  return executeChanges(
    `UPDATE instagram_send_state
        SET lease_token=NULL, lease_expires_at=NULL, lease_queue_id=NULL,
            lease_revision=NULL, lease_stage=NULL
      WHERE id=1 AND lease_token=?`,
    [token],
  );
}

function setThreadFailure(threadId: number, error: string): void {
  executeChanges(
    "UPDATE instagram_threads SET error=?, status=CASE WHEN customer_id IS NOT NULL OR status='converted' THEN 'converted' ELSE 'needs_human' END, updated_at=? WHERE id=?",
    [error, new Date().toISOString(), threadId],
  );
}

type PendingIdentityJob = {
  thread_id: number;
  revision: number;
  last_message_at: string;
  last_inbound_mid: string;
  requested_field: RequestedField | null;
  source: "api" | "flow";
};

let instagramIdentityWork: Promise<void> | null = null;

function identityJobs(): PendingIdentityJob[] {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const api = queryRows<Omit<PendingIdentityJob, "source">>(
    `SELECT q.thread_id,q.revision,t.last_message_at,t.requested_field,
            (SELECT m.mid FROM instagram_messages m WHERE m.thread_id=t.id AND m.direction='inbound'
             ORDER BY m.id DESC LIMIT 1) AS last_inbound_mid
       FROM instagram_send_queue q JOIN instagram_threads t ON t.id=q.thread_id
      WHERE q.error IN ('identity_pending','automation_disabled') AND q.state IN ('pending','failed')
        AND t.paused=0 AND t.last_message_at>=? AND q.updated_at>=?
      ORDER BY t.last_message_at,q.thread_id LIMIT 6`,
    [cutoff, cutoff],
  ).filter((job) => Boolean(job.last_message_at && job.last_inbound_mid))
    .map((job) => ({ ...job, source: "api" as const }));
  const flow = queryRows<Omit<PendingIdentityJob, "source">>(
    `SELECT r.thread_id,r.revision,t.last_message_at,t.requested_field,
            (SELECT m.mid FROM instagram_messages m WHERE m.thread_id=t.id AND m.direction='inbound'
             ORDER BY m.id DESC LIMIT 1) AS last_inbound_mid
       FROM instagram_flow_replies r JOIN instagram_threads t ON t.id=r.thread_id
      WHERE r.error IN ('identity_pending','automation_disabled') AND r.state IN ('pending','failed')
        AND t.paused=0 AND t.last_message_at>=? AND r.updated_at>=?
      ORDER BY t.last_message_at,r.thread_id LIMIT 6`,
    [cutoff, cutoff],
  ).filter((job) => Boolean(job.last_message_at && job.last_inbound_mid))
    .map((job) => ({ ...job, source: "flow" as const }));
  const jobs = [...api, ...flow].sort((a, b) =>
    a.last_message_at.localeCompare(b.last_message_at) || a.thread_id - b.thread_id);
  const unique = new Map<string, PendingIdentityJob>();
  for (const job of jobs) unique.set(`${job.source}:${job.thread_id}`, job);
  return [...unique.values()].slice(0, 6);
}

function applyExtractedIdentity(
  job: PendingIdentityJob,
  identity: Awaited<ReturnType<typeof extractInstagramIntakeIdentity>>,
): boolean {
  return runTransaction(() => {
    if (identity.nameMessageIds.length) {
      executeChanges(
        `UPDATE instagram_messages SET sensitive_name=1
          WHERE thread_id=? AND mid IN (${identity.nameMessageIds.map(() => "?").join(",")})`,
        [job.thread_id, ...identity.nameMessageIds],
      );
    }
    const thread = queryRow<InstagramThread>("SELECT * FROM instagram_threads WHERE id=?", [job.thread_id]);
    const latest = queryRow<{ mid: string }>(
      "SELECT mid FROM instagram_messages WHERE thread_id=? AND direction='inbound' ORDER BY id DESC LIMIT 1",
      [job.thread_id],
    );
    if (!thread || thread.paused || thread.last_message_at !== job.last_message_at ||
      latest?.mid !== job.last_inbound_mid) return false;
    const queueTable = job.source === "api" ? "instagram_send_queue" : "instagram_flow_replies";
    const currentJob = queryRow<{ revision: number; state: string; error: string | null }>(
      `SELECT revision,state,error FROM ${queueTable} WHERE thread_id=?`,
      [job.thread_id],
    );
    if (!currentJob || currentJob.revision !== job.revision ||
      !["pending", "failed"].includes(currentJob.state) ||
      !["identity_pending", "automation_disabled"].includes(currentJob.error ?? "")) return false;
    executeChanges(
      `UPDATE instagram_threads
          SET name=CASE WHEN (name IS NULL OR trim(name)='') OR ?=1 THEN ? ELSE name END,
              phone=COALESCE(NULLIF(phone,''),?),is_urgent=CASE WHEN is_urgent=1 OR ?=1 THEN 1 ELSE 0 END,
              updated_at=?
        WHERE id=? AND last_message_at=?`,
      [identity.correctedName ? 1 : 0, identity.name, identity.phone,
        identity.urgent ? 1 : 0, new Date().toISOString(), job.thread_id, job.last_message_at],
    );
    executeChanges(
      `UPDATE ${queueTable} SET error='identity_complete',updated_at=?
        WHERE thread_id=? AND revision=? AND state IN ('pending','failed')
          AND error IN ('identity_pending','automation_disabled')`,
      [new Date().toISOString(), job.thread_id, job.revision],
    );
    return true;
  });
}

async function processPendingInstagramIdentityJobs(): Promise<void> {
  if (instagramIdentityWork) return instagramIdentityWork;
  instagramIdentityWork = (async () => {
    for (const job of identityJobs()) {
      try {
        const messages = queryRows<InstagramIntakeMessage>(
          `SELECT mid,content,sent_at AS sentAt FROM instagram_messages
            WHERE thread_id=? AND direction='inbound' AND sent_at>=?
            ORDER BY id LIMIT 60`,
          [job.thread_id, new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()],
        );
        const thread = queryRow<InstagramThread>("SELECT * FROM instagram_threads WHERE id=?", [job.thread_id]);
        if (!thread) continue;
        const identity = await extractInstagramIntakeIdentity(messages, {
          currentName: thread.name,
          currentPhone: thread.phone,
          requestedField: job.requested_field,
        });
        if (!applyExtractedIdentity(job, identity)) continue;
        processAcceptedInstagramInbound(job.thread_id, job.last_inbound_mid, "");
      } catch {
        logger.warn(
          { component: "instagram-intake-identity", reason: "identity_extraction_failed" },
          "Instagram intake identity extraction failed",
        );
      }
    }
  })().finally(() => {
    instagramIdentityWork = null;
  });
  return instagramIdentityWork;
}

function acquireLease(replyMode: ManychatReplyMode, accountId: string): InstagramLease | null {
  const token = randomUUID();
  return runTransaction(() => {
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const state = queryRow<SendState>("SELECT * FROM instagram_send_state WHERE id=1");
    if (!state) return null;
    if (state.lease_token && state.lease_expires_at && new Date(state.lease_expires_at).getTime() > now) {
      return null;
    }
    if (state.lease_token && state.lease_stage === "sending" && state.lease_queue_id != null) {
      const stale = queryRow<{ state: string; revision: number; thread_id: number }>(
        "SELECT state, revision, thread_id FROM instagram_send_queue WHERE id=?",
        [state.lease_queue_id],
      );
      if (stale?.state === "sending" && stale.revision === state.lease_revision) {
        executeChanges(
          "UPDATE instagram_send_queue SET state='failed', requested_field=NULL, error='send_outcome_uncertain', updated_at=? WHERE id=? AND state='sending' AND revision=?",
          [nowIso, state.lease_queue_id, state.lease_revision],
        );
        setThreadFailure(stale.thread_id, "send_outcome_uncertain");
      }
    }
    const orphanedSends = queryRows<{ id: number; thread_id: number; revision: number }>(
      "SELECT id, thread_id, revision FROM instagram_send_queue WHERE state='sending'",
    );
    for (const orphan of orphanedSends) {
      executeChanges(
        "UPDATE instagram_send_queue SET state='failed', requested_field=NULL, error='send_outcome_uncertain', updated_at=? WHERE id=? AND state='sending' AND revision=?",
        [nowIso, orphan.id, orphan.revision],
      );
      setThreadFailure(orphan.thread_id, "send_outcome_uncertain");
    }
    executeChanges(
      `UPDATE instagram_send_state
          SET lease_token=NULL, lease_expires_at=NULL, lease_queue_id=NULL,
              lease_revision=NULL, lease_stage=NULL
        WHERE id=1`,
    );

    const queued = queryRow<{
      id: number;
      thread_id: number;
      due_at: string;
      revision: number;
      last_message_at: string;
      reply_messages_json: string | null;
      next_message_index: number;
      requested_field: RequestedField | null;
    }>(
      `SELECT q.id, q.thread_id, q.due_at, q.revision, t.last_message_at,
              q.reply_messages_json,q.next_message_index,q.requested_field
         FROM instagram_send_queue q JOIN instagram_threads t ON t.id=q.thread_id
        WHERE q.state='pending' AND COALESCE(q.error,'')<>'identity_pending' AND t.paused=0
        ORDER BY q.due_at, q.id LIMIT 1`,
    );
    if (!queued || !queued.last_message_at) return null;
    if (now - new Date(queued.last_message_at).getTime() > 24 * 60 * 60 * 1000) {
      executeChanges(
        "UPDATE instagram_send_queue SET state='failed', requested_field=NULL, error='outside_messaging_window', updated_at=? WHERE id=? AND state='pending' AND revision=?",
        [nowIso, queued.id, queued.revision],
      );
      setThreadFailure(queued.thread_id, "outside_messaging_window");
      return null;
    }
    const dueAt = Math.max(
      new Date(queued.due_at).getTime(),
      new Date(queued.last_message_at).getTime() + GLOBAL_SEND_SPACING_MS,
      state.last_sent_at ? new Date(state.last_sent_at).getTime() + GLOBAL_SEND_SPACING_MS : 0,
    );
    if (dueAt > now) {
      executeChanges(
        "UPDATE instagram_send_queue SET due_at=?, updated_at=? WHERE id=? AND state='pending' AND revision=?",
        [new Date(dueAt).toISOString(), nowIso, queued.id, queued.revision],
      );
      return null;
    }
    const claimed = executeChanges(
      `UPDATE instagram_send_state
          SET lease_token=?, lease_expires_at=?, lease_queue_id=?, lease_revision=?, lease_stage='processing'
        WHERE id=1 AND (lease_token IS NULL OR lease_expires_at IS NULL OR lease_expires_at<=?)`,
      [token, new Date(now + SEND_LEASE_MS).toISOString(), queued.id, queued.revision, nowIso],
    );
    if (!claimed) return null;
    const thread = queryRow<InstagramThread>("SELECT * FROM instagram_threads WHERE id=?", [queued.thread_id]);
    if (!thread?.last_message_at) {
      clearLease(token);
      return null;
    }
    const latestInbound = queryRow<{ mid: string }>(
      "SELECT mid FROM instagram_messages WHERE thread_id=? AND direction='inbound' ORDER BY sent_at DESC, id DESC LIMIT 1",
      [queued.thread_id],
    );
    if (!latestInbound) {
      clearLease(token);
      return null;
    }
    return {
      token,
      queueId: queued.id,
      threadId: queued.thread_id,
      revision: queued.revision,
      senderId: thread.sender_id,
      lastMessageAt: thread.last_message_at,
      lastInboundMid: latestInbound.mid,
      accountId,
      replyMode,
      replyMessagesJson: queued.reply_messages_json,
      nextMessageIndex: queued.next_message_index,
      requestedField: queued.requested_field,
    };
  });
}

function deferAndRelease(lease: InstagramLease, dueAt?: string): void {
  if (dueAt) {
    executeChanges(
      "UPDATE instagram_send_queue SET state='pending', due_at=?, updated_at=? WHERE id=? AND revision=? AND state IN ('pending','sending')",
      [dueAt, new Date().toISOString(), lease.queueId, lease.revision],
    );
  }
  clearLease(lease.token);
}

function failLease(lease: InstagramLease, error: string): void {
  runTransaction(() => {
    const changed = executeChanges(
      "UPDATE instagram_send_queue SET state='failed', requested_field=NULL, error=?, updated_at=? WHERE id=? AND revision=? AND state IN ('pending','sending')",
      [error, new Date().toISOString(), lease.queueId, lease.revision],
    );
    if (changed) setThreadFailure(lease.threadId, error);
    clearLease(lease.token);
  });
  logger.warn({ component: "instagram-worker", reason: error }, "Instagram send failed; no automatic retry");
}

function parseReplyMessages(json: string | null): string[] | null {
  if (!json) return null;
  try {
    const messages: unknown = JSON.parse(json);
    if (!Array.isArray(messages) || messages.length < 1 || messages.length > 10 ||
      messages.some((message) => typeof message !== "string" || !message.trim() ||
        Buffer.byteLength(message, "utf8") > 900)) return null;
    return messages;
  } catch {
    return null;
  }
}

function claimAfterModel(
  lease: InstagramLease,
  requestedField: RequestedField | null,
  replies: string[],
): boolean {
  return runTransaction(() => {
    const provider = manychatConfig();
    const now = Date.now();
    const state = queryRow<SendState>("SELECT * FROM instagram_send_state WHERE id=1");
    const queue = queryRow<{ state: string; revision: number; reply_messages_json: string | null }>(
      "SELECT state, revision, reply_messages_json FROM instagram_send_queue WHERE id=?",
      [lease.queueId],
    );
    const thread = queryRow<InstagramThread>("SELECT * FROM instagram_threads WHERE id=?", [lease.threadId]);
    const latestInbound = queryRow<{ mid: string }>(
      "SELECT mid FROM instagram_messages WHERE thread_id=? AND direction='inbound' ORDER BY sent_at DESC, id DESC LIMIT 1",
      [lease.threadId],
    );
    if (state?.lease_token !== lease.token) return false;
    if (!provider.enabled || provider.mode !== "api" || provider.replyMode !== lease.replyMode ||
      provider.accountId !== lease.accountId) {
      clearLease(lease.token);
      return false;
    }
    if (
      state.lease_stage !== "processing" ||
      !state.lease_expires_at ||
      new Date(state.lease_expires_at).getTime() <= now ||
      !queue ||
      queue.state !== "pending" ||
      queue.revision !== lease.revision ||
      !thread ||
      latestInbound?.mid !== lease.lastInboundMid
    ) {
      clearLease(lease.token);
      return false;
    }
    if (thread.paused || thread.last_message_at !== lease.lastMessageAt) {
      clearLease(lease.token);
      return false;
    }
    if (now - new Date(thread.last_message_at).getTime() > 24 * 60 * 60 * 1000) {
      executeChanges(
        "UPDATE instagram_send_queue SET state='failed', requested_field=NULL, error='outside_messaging_window', updated_at=? WHERE id=? AND revision=? AND state='pending'",
        [new Date(now).toISOString(), lease.queueId, lease.revision],
      );
      setThreadFailure(lease.threadId, "outside_messaging_window");
      clearLease(lease.token);
      return false;
    }
    const globalLast = state.last_sent_at ? new Date(state.last_sent_at).getTime() : 0;
    if (globalLast && now - globalLast < GLOBAL_SEND_SPACING_MS) {
      executeChanges(
        "UPDATE instagram_send_queue SET due_at=?, updated_at=? WHERE id=? AND revision=? AND state='pending'",
        [new Date(globalLast + GLOBAL_SEND_SPACING_MS).toISOString(), new Date(now).toISOString(), lease.queueId, lease.revision],
      );
      clearLease(lease.token);
      return false;
    }
    const changed = executeChanges(
      `UPDATE instagram_send_queue
          SET state='sending', requested_field=?, reply_messages_json=COALESCE(reply_messages_json, ?),
              updated_at=?, error=NULL
        WHERE id=? AND state='pending' AND revision=?`,
      [requestedField, JSON.stringify(replies), new Date(now).toISOString(), lease.queueId, lease.revision],
    );
    if (!changed) {
      clearLease(lease.token);
      return false;
    }
    executeChanges(
      "UPDATE instagram_send_state SET lease_expires_at=? WHERE id=1 AND lease_token=? AND lease_stage='processing'",
      [new Date(now + SEND_LEASE_MS).toISOString(), lease.token],
    );
    return true;
  });
}

// Last atomic check before fetch. SQLite work completes before network I/O.
function authorizeFetch(lease: InstagramLease, expectedAccountId: string, expectedToken: string): boolean {
  return runTransaction(() => {
    const currentProvider = manychatConfig();
    if (!currentProvider.enabled || currentProvider.mode !== "api" ||
      currentProvider.replyMode !== lease.replyMode ||
      currentProvider.accountId !== expectedAccountId || currentProvider.apiToken !== expectedToken) {
      clearLease(lease.token);
      return false;
    }
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const state = queryRow<SendState>("SELECT * FROM instagram_send_state WHERE id=1");
    const queue = queryRow<{ state: string; revision: number }>(
      "SELECT state, revision FROM instagram_send_queue WHERE id=?",
      [lease.queueId],
    );
    const thread = queryRow<InstagramThread>("SELECT * FROM instagram_threads WHERE id=?", [lease.threadId]);
    const latestInbound = queryRow<{ mid: string }>(
      "SELECT mid FROM instagram_messages WHERE thread_id=? AND direction='inbound' ORDER BY sent_at DESC, id DESC LIMIT 1",
      [lease.threadId],
    );
    if (state?.lease_token !== lease.token) return false;
    if (
      state.lease_stage !== "processing" ||
      !state.lease_expires_at ||
      new Date(state.lease_expires_at).getTime() <= now ||
      !queue ||
      queue.state !== "sending" ||
      queue.revision !== lease.revision ||
      !thread ||
      latestInbound?.mid !== lease.lastInboundMid
    ) {
      clearLease(lease.token);
      return false;
    }
    if (thread.paused || thread.last_message_at !== lease.lastMessageAt) {
      const dueAt = thread.last_message_at
        ? new Date(new Date(thread.last_message_at).getTime() + GLOBAL_SEND_SPACING_MS).toISOString()
        : undefined;
      deferAndRelease(lease, dueAt);
      return false;
    }
    if (now - new Date(thread.last_message_at).getTime() > 24 * 60 * 60 * 1000) {
      executeChanges(
        "UPDATE instagram_send_queue SET state='failed', requested_field=NULL, error='outside_messaging_window', updated_at=? WHERE id=? AND revision=? AND state='sending'",
        [nowIso, lease.queueId, lease.revision],
      );
      setThreadFailure(lease.threadId, "outside_messaging_window");
      clearLease(lease.token);
      return false;
    }
    const lastSent = state.last_sent_at ? new Date(state.last_sent_at).getTime() : 0;
    if (lastSent && now - lastSent < GLOBAL_SEND_SPACING_MS) {
      deferAndRelease(lease, new Date(lastSent + GLOBAL_SEND_SPACING_MS).toISOString());
      return false;
    }
    return executeChanges(
      `UPDATE instagram_send_state
          SET last_sent_at=?, lease_stage='sending'
        WHERE id=1 AND lease_token=? AND lease_stage='processing'`,
      [nowIso, lease.token],
    ) === 1;
  });
}

async function processQueue(): Promise<void> {
  if (workerRunning) return;
  workerRunning = true;
  let lease: InstagramLease | null = null;
  try {
    await processPendingInstagramIdentityJobs();
    const provider = manychatConfig();
    if (!provider.enabled || provider.mode !== "api") return;
    lease = acquireLease(provider.replyMode, provider.accountId);
    if (!lease) return;
    const expectedPrefix = `mc:${provider.accountId}:`;
    if (!lease.senderId.startsWith(expectedPrefix) ||
      !/^[1-9]\d{0,15}$/.test(lease.senderId.slice(expectedPrefix.length))) {
      failLease(lease, "provider_or_account_changed");
      lease = null;
      return;
    }
    let replies: string[];
    let requestedField = lease.requestedField;
    let crmQuestion = requestedField === "request";
    try {
      const frozen = parseReplyMessages(lease.replyMessagesJson);
      if (lease.replyMessagesJson !== null && !frozen) throw new Error("frozen_batch_invalid");
      if (frozen) {
        replies = frozen;
      } else {
        const prepared = await prepareReply(lease.threadId, lease.replyMode);
        replies = prepared.replies;
        requestedField = prepared.crmQuestion ? "request" : prepared.requestedField;
        crmQuestion = prepared.crmQuestion;
      }
      if (!Number.isInteger(lease.nextMessageIndex) || lease.nextMessageIndex < 0 ||
        lease.nextMessageIndex >= replies.length) throw new Error("frozen_batch_index_invalid");
    } catch (error) {
      const preparationError = error instanceof Error && error.message.startsWith("frozen_batch")
        ? "frozen_batch_invalid"
        : lease.replyMode === "ai" ? instagramAiFailureCode(error) : "reply_preparation_failed";
      failLease(lease, preparationError);
      lease = null;
      return;
    }
    if (!claimAfterModel(lease, requestedField, replies) ||
      !authorizeFetch(lease, provider.accountId, provider.apiToken)) {
      lease = null;
      return;
    }
    // Do not await between the final database authorization and starting fetch.
    let response: Response;
    try {
      response = await sendManychatReply(
        lease.senderId.slice(expectedPrefix.length), replies[lease.nextMessageIndex], provider.apiToken,
      );
    } catch {
      failLease(lease, "send_outcome_uncertain");
      lease = null;
      return;
    }
    if (!response.ok) {
      if (response.status === 429) {
        runTransaction(() => {
          const changed = executeChanges(
            "UPDATE instagram_send_queue SET state='pending', due_at=?, error='rate_limited', updated_at=? WHERE id=? AND revision=? AND state='sending'",
            [new Date(Date.now() + 60_000).toISOString(), new Date().toISOString(), lease!.queueId, lease!.revision],
          );
          if (changed) {
            executeChanges(
              "UPDATE instagram_threads SET error='rate_limited', updated_at=? WHERE id=?",
              [new Date().toISOString(), lease!.threadId],
            );
          }
          clearLease(lease!.token);
        });
        lease = null;
        return;
      }
      failLease(lease, `http_${response.status}`);
      lease = null;
      return;
    }
    const result = await response.json().catch(() => ({})) as { status?: string; message_id?: string };
    if (result.status !== "success") {
      failLease(lease, "provider_rejected_send");
      lease = null;
      return;
    }
    const sentAt = new Date().toISOString();
    let crmQuestionDelivered = false;
    const completedThreadId = lease.threadId;
    runTransaction(() => {
      const outboundMid =
        `out:${lease!.queueId}:${lease!.revision}:${lease!.nextMessageIndex}`;
      execute(
        `INSERT OR IGNORE INTO instagram_messages
           (thread_id, mid, direction, content, sent_at)
         VALUES (?, ?, 'outbound', ?, ?)`,
        [
          lease!.threadId,
          outboundMid,
          replies[lease!.nextMessageIndex],
          sentAt,
        ],
      );
      const receipt = queryRow<{ thread_id: number; direction: string; content: string }>(
        "SELECT thread_id,direction,content FROM instagram_messages WHERE mid=?",
        [outboundMid],
      );
      if (
        !receipt ||
        receipt.thread_id !== lease!.threadId ||
        receipt.direction !== "outbound" ||
        receipt.content !== replies[lease!.nextMessageIndex]
      ) throw new Error("outbound_receipt_conflict");
      const nextMessageIndex = lease!.nextMessageIndex + 1;
      const hasMoreMessages = nextMessageIndex < replies.length;
      const updatedQueue = executeChanges(
        `UPDATE instagram_send_queue
            SET state=?, next_message_index=?, due_at=?, updated_at=?, error=NULL
          WHERE id=? AND revision=? AND state='sending'`,
        [
          hasMoreMessages ? "pending" : "sent",
          nextMessageIndex,
          hasMoreMessages
            ? new Date(new Date(sentAt).getTime() + GLOBAL_SEND_SPACING_MS).toISOString()
            : sentAt,
          sentAt,
          lease!.queueId,
          lease!.revision,
        ],
      );
      const latestInbound = queryRow<{ mid: string }>(
        "SELECT mid FROM instagram_messages WHERE thread_id=? AND direction='inbound' ORDER BY sent_at DESC, id DESC LIMIT 1",
        [lease!.threadId],
      );
      if (updatedQueue && latestInbound?.mid === lease!.lastInboundMid) {
        executeChanges(
          "UPDATE instagram_threads SET requested_field=? WHERE id=? AND last_message_at=?",
          [requestedField, lease!.threadId, lease!.lastMessageAt],
        );
      }
      if (updatedQueue) {
        executeChanges(
          "UPDATE instagram_threads SET last_reply_at=?, error=NULL, updated_at=? WHERE id=?",
          [sentAt, sentAt, lease!.threadId],
        );
        crmQuestionDelivered = crmQuestion && !hasMoreMessages;
      }
      clearLease(lease!.token);
    });
    if (crmQuestionDelivered) {
      observeInstagramCrmOperation(
        () => markInstagramCrmQuestionDelivered(completedThreadId),
        "instagram-crm-question-delivery",
      );
    }
    lease = null;
  } catch {
    // If an unexpected failure occurs after send-claim, retain the durable lease
    // and let expiry recovery mark the result uncertain instead of resending.
    logger.warn(
      { component: "instagram-worker", reason: "instagram_worker_operation_failed" },
      "Instagram worker operation failed",
    );
  } finally {
    workerRunning = false;
  }
}

type FlowJob = {
  thread_id: number;
  account_id: string;
  request_id: string;
  revision: number;
  received_at: string;
  replyMode: ManychatReplyMode;
};

async function processFlowReplies(): Promise<void> {
  if (flowWorkerRunning) return;
  flowWorkerRunning = true;
  try {
    await processPendingInstagramIdentityJobs();
    const provider = manychatConfig();
    if (!provider.enabled || provider.mode !== "flow") return;
    const job = runTransaction(() => {
      const now = new Date().toISOString();
      const candidate = queryRow<FlowJob & { paused: number; last_message_at: string | null }>(
        `SELECT r.*, t.paused, t.last_message_at FROM instagram_flow_replies r
           JOIN instagram_threads t ON t.id=r.thread_id
         WHERE r.account_id=? AND t.paused=0 AND COALESCE(r.error,'')<>'identity_pending'
           AND (r.state='pending' OR (r.state='processing' AND r.lease_expires_at<=?))
         ORDER BY r.updated_at, r.thread_id LIMIT 1`,
        [provider.accountId, now],
      );
      if (!candidate) return null;
      if (candidate.last_message_at !== candidate.received_at) {
        executeChanges(
          "UPDATE instagram_flow_replies SET state='failed', reply_text=NULL, reply_messages_json=NULL, next_item_index=0, error='newer_message', updated_at=? WHERE thread_id=? AND revision=?",
          [now, candidate.thread_id, candidate.revision],
        );
        return null;
      }
      const claimed = executeChanges(
        `UPDATE instagram_flow_replies SET state='processing', revision=revision+1, lease_expires_at=?, updated_at=?
           WHERE thread_id=? AND revision=? AND state IN ('pending','processing')`,
        [new Date(Date.now() + SEND_LEASE_MS).toISOString(), now, candidate.thread_id, candidate.revision],
      );
      return claimed ? { ...candidate, revision: candidate.revision + 1, replyMode: provider.replyMode } : null;
    });
    if (!job) return;
    let prepared: PreparedInstagramReply;
    try {
      prepared = await prepareReply(job.thread_id, job.replyMode);
    } catch (error) {
      const preparationError = job.replyMode === "ai"
        ? instagramAiFailureCode(error) : "reply_preparation_failed";
      runTransaction(() => {
        const changed = executeChanges(
          "UPDATE instagram_flow_replies SET state='failed', reply_text=NULL, reply_messages_json=NULL, next_item_index=0, requested_field=NULL, error=?, updated_at=?, lease_expires_at=NULL WHERE thread_id=? AND revision=? AND state='processing'",
          [preparationError, new Date().toISOString(), job.thread_id, job.revision],
        );
        if (changed) setThreadFailure(job.thread_id, preparationError);
      });
      logger.warn(
        { component: "instagram-flow-worker", reason: preparationError },
        "Flow reply preparation failed; no reply was published",
      );
      return;
    }
    runTransaction(() => {
      const current = manychatConfig();
      const thread = queryRow<InstagramThread>("SELECT * FROM instagram_threads WHERE id=?", [job.thread_id]);
      const record = queryRow<{ state: string; revision: number; lease_expires_at: string | null }>(
        "SELECT state, revision, lease_expires_at FROM instagram_flow_replies WHERE thread_id=?",
        [job.thread_id],
      );
      if (!current.enabled || current.mode !== "flow" || current.replyMode !== job.replyMode ||
        current.accountId !== job.account_id ||
        thread?.paused || thread?.last_message_at !== job.received_at || record?.state !== "processing" ||
        record.revision !== job.revision || !record.lease_expires_at ||
        record.lease_expires_at <= new Date().toISOString()) return;
      executeChanges(
        "UPDATE instagram_flow_replies SET state='ready', reply_text=?, reply_messages_json=?, next_item_index=0, requested_field=?, lease_expires_at=NULL, updated_at=? WHERE thread_id=? AND revision=? AND state='processing'",
        [prepared.reply, JSON.stringify(prepared.replies), prepared.crmQuestion ? "request" : prepared.requestedField,
          new Date().toISOString(), job.thread_id, job.revision],
      );
    });
  } catch {
    logger.warn(
      { component: "instagram-flow-worker", reason: "instagram_flow_worker_operation_failed" },
      "Flow reply preparation failed",
    );
  } finally {
    flowWorkerRunning = false;
  }
}

export function claimManychatFlowReply(accountId: string, subscriberId: string, requestId: string): {
  ready: "yes" | "no"; reply: string;
} {
  const claimed = runTransaction(() => {
    const unavailable = { ready: "no" as const, reply: "" };
    const provider = manychatConfig();
    if (!provider.enabled || provider.mode !== "flow" || provider.accountId !== accountId) return unavailable;
    const now = new Date();
    const record = queryRow<{ thread_id: number; state: string; reply_text: string | null;
      reply_messages_json: string | null;
      requested_field: RequestedField | null; received_at: string; paused: number; last_message_at: string | null }>(
      `SELECT r.thread_id, r.state, r.reply_text, r.reply_messages_json, r.requested_field,
              r.received_at, t.paused, t.last_message_at
         FROM instagram_flow_replies r JOIN instagram_threads t ON t.id=r.thread_id
        WHERE r.account_id=? AND r.request_id=? AND t.sender_id=?`,
      [accountId, requestId, `mc:${accountId}:${subscriberId}`],
    );
    const messages = record?.reply_messages_json
      ? parseReplyMessages(record.reply_messages_json)
      : record?.reply_text ? [record.reply_text] : null;
    if (!record || record.state !== "ready" || !record.reply_text || !messages || messages.length !== 1 || record.paused ||
      record.last_message_at !== record.received_at ||
      now.getTime() - new Date(record.received_at).getTime() < 60_000 ||
      now.getTime() - new Date(record.received_at).getTime() > 24 * 60 * 60 * 1000) return unavailable;
    if (!executeChanges(
      "UPDATE instagram_flow_replies SET state='handed_off', updated_at=? WHERE thread_id=? AND request_id=? AND state='ready'",
      [now.toISOString(), record.thread_id, requestId],
    )) return unavailable;
    executeChanges(
      "UPDATE instagram_threads SET requested_field=?, updated_at=? WHERE id=? AND last_message_at=? AND paused=0",
      [record.requested_field, now.toISOString(), record.thread_id, record.received_at],
    );
    execute(
      `INSERT OR IGNORE INTO instagram_flow_handoffs (thread_id, request_id, content, created_at)
       SELECT thread_id, request_id, reply_text, ? FROM instagram_flow_replies
        WHERE thread_id=? AND request_id=? AND state='handed_off' AND reply_text IS NOT NULL`,
      [now.toISOString(), record.thread_id, requestId],
    );
    // Handoff is not a provider delivery receipt; never mark this as an
    // outbound Instagram message or update last_reply_at.
    return {
      ready: "yes" as const,
      reply: record.reply_text,
    };
  });
  return { ready: claimed.ready, reply: claimed.reply };
}

export function claimManychatFlowReplyItem(
  accountId: string,
  subscriberId: string,
  requestId: string,
  ordinal: number,
): {
  ready: "yes" | "no";
  requestId: string;
  ordinal: number;
  messages: string[];
  hasMore: boolean;
  nextItem: { requestId: string; ordinal: number } | null;
} {
  const unavailable = {
    ready: "no" as const,
    requestId,
    ordinal,
    messages: [],
    hasMore: false,
    nextItem: null,
  };
  if (!Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal >= 10) return unavailable;
  return runTransaction(() => {
    const provider = manychatConfig();
    if (!provider.enabled || provider.mode !== "flow" || provider.accountId !== accountId) return unavailable;
    const record = queryRow<{
      thread_id: number;
      state: string;
      reply_text: string | null;
      reply_messages_json: string | null;
      next_item_index: number;
      received_at: string;
      paused: number;
      last_message_at: string | null;
    }>(
      `SELECT r.thread_id, r.state, r.reply_text, r.reply_messages_json, r.next_item_index,
              r.received_at, t.paused, t.last_message_at
         FROM instagram_flow_replies r JOIN instagram_threads t ON t.id=r.thread_id
        WHERE r.account_id=? AND r.request_id=? AND t.sender_id=?`,
      [accountId, requestId, `mc:${accountId}:${subscriberId}`],
    );
    const messages = record?.reply_messages_json
      ? parseReplyMessages(record.reply_messages_json)
      : record?.reply_text ? [record.reply_text] : null;
    const now = new Date();
    if (!record || record.state !== "ready" || !messages || messages.length === 0 ||
      ordinal !== record.next_item_index || record.paused ||
      record.last_message_at !== record.received_at ||
      now.getTime() - new Date(record.received_at).getTime() < 60_000 ||
      now.getTime() - new Date(record.received_at).getTime() > 24 * 60 * 60 * 1000) return unavailable;
    const hasMore = ordinal + 1 < messages.length;
    if (!executeChanges(
      `UPDATE instagram_flow_replies
          SET next_item_index=?, state=?, updated_at=?
        WHERE thread_id=? AND request_id=? AND state='ready' AND next_item_index=?`,
      [ordinal + 1, hasMore ? "ready" : "handed_off", now.toISOString(),
        record.thread_id, requestId, ordinal],
    )) return unavailable;
    execute(
      `INSERT INTO instagram_flow_handoff_items
         (thread_id, request_id, ordinal, content, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [record.thread_id, requestId, ordinal, messages[ordinal], now.toISOString()],
    );
    return {
      ready: "yes" as const,
      requestId,
      ordinal,
      messages: [messages[ordinal]],
      hasMore,
      nextItem: hasMore ? { requestId, ordinal: ordinal + 1 } : null,
    };
  });
}

export function startInstagramWorker(): void {
  if (workerTimer) return;
  workerTimer = setInterval(() => {
    observeInstagramCrmOperation(
      () => processInstagramCrmAutomationDue(),
      "instagram-crm-due-worker",
    );
    void processPendingInstagramIdentityJobs();
    void processQueue();
    void processFlowReplies();
  }, 2_000);
  workerTimer.unref();
}

export function instagramThreadData(thread: Record<string, unknown>) {
  return {
    id: Number(thread.id),
    senderId: thread.sender_id,
    name: thread.name ?? null,
    phone: thread.phone ?? null,
    request: thread.request ?? null,
    customerId: thread.customer_id == null ? null : Number(thread.customer_id),
    status: thread.status,
    paused: Boolean(thread.paused),
    lastMessageAt: thread.last_message_at ?? null,
    lastMessage: thread.last_message ?? null,
    lastReplyAt: thread.last_reply_at ?? null,
    error: thread.error ?? null,
  };
}

export function pauseInstagramThread(threadId: number, paused: boolean): boolean {
  return runTransaction(() => {
    const now = new Date().toISOString();
    const changed = executeChanges(
      `UPDATE instagram_threads
         SET paused=?, status=CASE WHEN customer_id IS NOT NULL OR status='converted' THEN 'converted'
                                   WHEN ?=1 THEN 'needs_human'
                                   WHEN duplicate_review=1 THEN 'needs_review'
                                   ELSE 'open' END,
             updated_at=? WHERE id=?`,
      [paused ? 1 : 0, paused ? 1 : 0, now, threadId],
    );
    if (paused) {
      executeChanges(
        "UPDATE instagram_send_queue SET due_at=?, updated_at=? WHERE thread_id=? AND state='pending'",
        ["9999-12-31T23:59:59.999Z", now, threadId],
      );
      executeChanges(
        "UPDATE instagram_flow_replies SET state='failed', revision=revision+1, reply_text=NULL, requested_field=NULL, lease_expires_at=NULL, error='conversation_paused', updated_at=? WHERE thread_id=? AND state IN ('pending','processing','ready')",
        [now, threadId],
      );
    } else {
      executeChanges(
        "UPDATE instagram_send_queue SET due_at=?, updated_at=? WHERE thread_id=? AND state='pending'",
        [new Date(Date.now() + GLOBAL_SEND_SPACING_MS).toISOString(), now, threadId],
      );
    }
    return changed > 0;
  });
}