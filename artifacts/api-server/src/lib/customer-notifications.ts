import { createHmac } from "node:crypto";
import { smsFetch } from "./sms-proxy";
import { execute, queryRow, queryRows } from "./crm-db";

export type NotificationSettings = {
  ippanelEnabled: boolean;
  ippanelRelayUrl: string;
  ippanelFromNumber: string;
  ippanelPatternCode: string;
  telegramEnabled: boolean;
  telegramGroupChatId: string;
  telegramMessageTemplate: string;
};

export const defaultNotificationSettings: NotificationSettings = {
  ippanelEnabled: true,
  ippanelRelayUrl: "http://127.0.0.1:18787/send",
  ippanelFromNumber: "+983000505",
  ippanelPatternCode: "wuk6lgtho227bxc",
  telegramEnabled: true,
  telegramGroupChatId: "-1002096110105",
  telegramMessageTemplate: `📋 مشتری جدید ثبت شد

👤 نام: {name}
📱 موبایل: {phone}
👨‍💼 کارشناس: {salesperson}
📝 توضیحات:
{description}`,
};

const settingKeys = Object.keys(defaultNotificationSettings) as Array<keyof NotificationSettings>;

export function getNotificationSettings(): NotificationSettings {
  const rows = queryRows<{ key: string; value: string }>(
    "SELECT key, value FROM notification_settings",
  );
  const stored = new Map(rows.map((row) => [row.key, row.value]));
  return Object.fromEntries(
    settingKeys.map((key) => {
      const fallback = defaultNotificationSettings[key];
      const value = stored.get(key);
      return [key, typeof fallback === "boolean" ? value == null ? fallback : value === "true" : value ?? fallback];
    }),
  ) as NotificationSettings;
}

export function saveNotificationSettings(settings: NotificationSettings): void {
  const now = new Date().toISOString();
  for (const key of settingKeys) {
    execute(
      `INSERT INTO notification_settings (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [key, String(settings[key]), now],
    );
  }
}

type NotificationCustomer = {
  id: number;
  name: string;
  phone: string;
  description: string | null;
  salespersonName: string | null;
  salespersonMobile: string | null;
};

export function normalizeIranianMobile(value: string): string | undefined {
  const digits = value
    .replace(/[۰-۹]/g, (digit) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit)))
    .replace(/[٠-٩]/g, (digit) => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)))
    .replace(/[^\d+]/g, "");
  if (/^09\d{9}$/.test(digits)) return `+98${digits.slice(1)}`;
  if (/^989\d{9}$/.test(digits)) return `+${digits}`;
  if (/^\+989\d{9}$/.test(digits)) return digits;
  return undefined;
}

function fillTemplate(template: string, customer: NotificationCustomer): string {
  const values: Record<string, string> = {
    name: customer.name,
    phone: customer.phone,
    salesperson: customer.salespersonName || "بدون تخصیص",
    salespersonPhone: customer.salespersonMobile || "ثبت نشده",
    description: customer.description?.trim() || "بدون توضیحات",
  };
  return template.replace(/\{(name|phone|salesperson|salespersonPhone|description)\}/g, (_, key: string) => values[key] ?? "");
}

function recordDelivery(customerId: number, channel: string, status: string, error?: string): void {
  execute(
    `INSERT INTO notification_deliveries (customer_id, channel, status, error_message, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    [customerId, channel, status, error?.slice(0, 500) ?? null, new Date().toISOString()],
  );
}

/**
 * Per-call options for {@link notifyNewCustomer}. Every field is optional and the defaults are exactly the
 * historic behaviour (staff Telegram + customer SMS), so only callers that opt in change anything.
 */
export type NewCustomerNotificationOptions = {
  /** `false` skips the customer SMS (ippanel) for this call only. Default: send. */
  customerSms?: boolean;
  /** Marks the staff Telegram with where the lead came from. */
  source?: "website";
  /** Website "call me back" request instead of the full request wizard. */
  kind?: "request" | "callback";
  /** Free-text preferred call time from the site; shown to staff whenever present. */
  preferredTime?: string;
  /**
   * The website form was sent from a phone that already belongs to a CRM customer. Staff get the same alert,
   * marked «مشتری قبلی» with the file number (customer id), and the template's «مشتری جدید» line is reworded.
   */
  existingCustomer?: boolean;
  /** What was asked in this submission (an existing customer's stored description is older). */
  requestDetails?: string;
};

/** Staff marker for a website form sent by someone who is already a customer. */
export function existingCustomerMarker(customerId: number): string {
  return `👤 مشتری قبلی — شماره پرونده: ${customerId}`;
}

function cleanLine(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
  return text || undefined;
}

function telegramText(customer: NotificationCustomer, settings: NotificationSettings, options: NewCustomerNotificationOptions): string {
  let body = fillTemplate(settings.telegramMessageTemplate, customer);
  if (options.source !== "website") return body;
  const existing = options.existingCustomer === true && customer.id > 0;
  if (existing) body = body.replace("مشتری جدید ثبت شد", "درخواست جدید از مشتری قبلی");
  const header = [
    ...(existing ? [existingCustomerMarker(customer.id)] : []),
    options.kind === "callback" ? "🌐 منبع: سایت (درخواست تماس)" : "🌐 منبع: سایت",
  ];
  const preferredTime = cleanLine(options.preferredTime, 120);
  if (preferredTime) header.push(`⏰ زمان ترجیحی تماس: ${preferredTime}`);
  if (options.customerSms === false) header.push("ℹ️ پیامک خودکار برای مشتری ارسال نشد؛ لطفاً تماس بگیرید.");
  const details = typeof options.requestDetails === "string" ? options.requestDetails.trim().slice(0, 1500) : "";
  if (details) header.push("", "📝 این درخواست:", details);
  return `${header.join("\n")}\n\n${body}`;
}

async function sendTelegram(customer: NotificationCustomer, settings: NotificationSettings, options: NewCustomerNotificationOptions = {}): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!settings.telegramEnabled) return;
  if (!token) {
    recordDelivery(customer.id, "telegram", "not_configured", "Telegram bot token is not configured");
    return;
  }
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: settings.telegramGroupChatId,
      text: telegramText(customer, settings, options),
    }),
  });
  if (!response.ok) throw new Error(`Telegram returned HTTP ${response.status}`);
  recordDelivery(customer.id, "telegram", "sent");
}

/**
 * Staff Telegram for a website «درخواست تماس» (callback). A callback is not a customer, so there is no
 * customer row, no notification_deliveries record and never a customer SMS: the same staff alert as a
 * website lead (template + «🌐 منبع: سایت (درخواست تماس)» + «⏰ زمان ترجیحی تماس») is sent and the
 * outcome is returned for the caller to log on the callback's own history.
 */
export type WebsiteCallbackAlert = {
  name: string;
  phone: string;
  /** Already in Persian, e.g. «همین الان (ساعت کاری)» / «صبح (۹ تا ۱۳)». */
  contactTimeFa: string;
  description: string;
  /** Linked CRM customer (file number) when the phone already belongs to a customer. */
  existingCustomerId?: number | null;
};
export type CallbackAlertOutcome = "sent" | "disabled" | "not_configured" | "failed";

export async function notifyWebsiteCallback(alert: WebsiteCallbackAlert): Promise<CallbackAlertOutcome> {
  const settings = getNotificationSettings();
  if (!settings.telegramEnabled) return "disabled";
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return "not_configured";
  const existingId = alert.existingCustomerId && alert.existingCustomerId > 0 ? alert.existingCustomerId : 0;
  const pseudo: NotificationCustomer = {
    id: existingId, name: alert.name, phone: alert.phone, description: alert.description, salespersonName: null, salespersonMobile: null,
  };
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: settings.telegramGroupChatId,
        text: telegramText(pseudo, settings, { customerSms: false, source: "website", kind: "callback", preferredTime: alert.contactTimeFa, existingCustomer: existingId > 0 }),
      }),
    });
    return response.ok ? "sent" : "failed";
  } catch {
    return "failed";
  }
}

/**
 * crm-site-leads: one grouped staff message in the EXISTING staff Telegram group when the preferred call window of
 * still-unanswered website requests starts. Uses the current notification_settings as they are (no new channel, no
 * settings change, no customer SMS, no notification_deliveries row). Returns the same outcomes as the callback alert.
 */
export async function notifySiteLeadWindow(alerts: { customerId: number; customerName: string; contactTime: "morning" | "evening" }[], ownerName: string | null): Promise<CallbackAlertOutcome> {
  if (!alerts.length) return "disabled";
  const settings = getNotificationSettings();
  if (!settings.telegramEnabled) return "disabled";
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !settings.telegramGroupChatId) return "not_configured";
  const window = alerts[0].contactTime === "morning" ? "صبح (۹ تا ۱۳)" : "عصر (۱۳ تا ۱۸)";
  const lines = alerts.slice(0, 30).map((a) => `• ${a.customerName || "مشتری"} — پرونده ${a.customerId}`);
  if (alerts.length > 30) lines.push(`… و ${alerts.length - 30} مشتری دیگر`);
  const text = [`⏰ زمان تماس درخواستی رسید: ${window}`, `🌐 سرنخ سایت — هنوز تماسی ثبت نشده است${ownerName ? ` (${ownerName})` : ""}`, "", ...lines].join("\n");
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(20_000),
      body: JSON.stringify({ chat_id: settings.telegramGroupChatId, text }),
    });
    return response.ok ? "sent" : "failed";
  } catch {
    return "failed";
  }
}

async function sendIppanel(customer: NotificationCustomer, settings: NotificationSettings): Promise<void> {
  if (!settings.ippanelEnabled) return;
  const relaySecret = process.env.IR_RELAY_SHARED_SECRET;
  if (!relaySecret) {
    recordDelivery(customer.id, "ippanel", "not_configured", "SMS relay signing secret is not configured");
    return;
  }
  let relayUrl: URL;
  try {
    relayUrl = new URL(settings.ippanelRelayUrl);
    if (!["http:", "https:"].includes(relayUrl.protocol) || relayUrl.username || relayUrl.password) {
      throw new Error("invalid relay URL");
    }
  } catch {
    recordDelivery(customer.id, "ippanel", "not_configured", "SMS relay URL is invalid");
    return;
  }
  const recipient = normalizeIranianMobile(customer.phone);
  if (!recipient) {
    recordDelivery(customer.id, "ippanel", "invalid_recipient", "Customer mobile is not a valid Iranian mobile number");
    return;
  }
  const salespersonMobile = customer.salespersonMobile
    ? normalizeIranianMobile(customer.salespersonMobile)?.replace("+98", "0") || customer.salespersonMobile
    : "—";
  let response: Response;
  try {
    const body = JSON.stringify({
      sending_type: "pattern",
      from_number: settings.ippanelFromNumber,
      code: settings.ippanelPatternCode,
      recipients: [recipient],
      params: {
        name: customer.name.slice(0, 40),
        sale_name: (customer.salespersonName || "کارشناس فروش").slice(0, 40),
        sale_mobile: String(salespersonMobile).slice(0, 40),
      },
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac("sha256", relaySecret)
      .update(`${timestamp}.${body}`)
      .digest("hex");
    response = await smsFetch(relayUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Relay-Timestamp": timestamp,
        "X-Relay-Signature": signature,
      },
      signal: AbortSignal.timeout(30_000),
      body,
    });
  } catch {
    throw new Error("Connection to the SMS relay failed");
  }
  let result: Record<string, unknown>;
  try {
    result = await response.json() as Record<string, unknown>;
  } catch {
    throw new Error(`SMS relay returned an invalid response (HTTP ${response.status})`);
  }
  if (result.ok !== true) {
    const relayError = result.error ?? result.detail ?? result.data ?? "Unknown relay error";
    const message = typeof relayError === "string" ? relayError : JSON.stringify(relayError);
    throw new Error(`SMS relay rejected the request: ${message.slice(0, 300)}`);
  }
  recordDelivery(customer.id, "ippanel", "sent");
}

/** Sends the deliberately narrow wallet-link pattern; callers claim delivery
 * before invoking this function because a relay timeout may be ambiguous. */
export async function sendWalletShareSms(
  customer: { id: number; name: string; phone: string },
  link: string,
  settings: NotificationSettings = getNotificationSettings(),
): Promise<string> {
  if (!settings.ippanelEnabled) throw new Error("sms_disabled");
  const relaySecret = process.env.IR_RELAY_SHARED_SECRET;
  if (!relaySecret) throw new Error("sms_relay_not_configured");
  let relayUrl: URL;
  try {
    relayUrl = new URL(settings.ippanelRelayUrl);
    if (!["http:", "https:"].includes(relayUrl.protocol) || relayUrl.username || relayUrl.password) throw new Error("invalid relay URL");
  } catch { throw new Error("sms_relay_not_configured"); }
  const recipient = normalizeIranianMobile(customer.phone);
  if (!recipient) throw new Error("invalid_phone");
  const body = JSON.stringify({
    sending_type: "pattern",
    from_number: settings.ippanelFromNumber,
    code: "uvqibx6zabmclkb",
    recipients: [recipient],
    params: { name: customer.name.slice(0, 40), link },
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", relaySecret).update(`${timestamp}.${body}`).digest("hex");
  let response: Response;
  try {
    response = await smsFetch(relayUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Relay-Timestamp": timestamp, "X-Relay-Signature": signature },
      signal: AbortSignal.timeout(30_000),
      body,
    });
  } catch { throw new Error("sms_delivery_unknown"); }
  let result: Record<string, unknown>;
  try { result = await response.json() as Record<string, unknown>; }
  catch { throw new Error("sms_delivery_unknown"); }
  const provider = result.data as { meta?: { status?: boolean }; data?: { message_outbox_ids?: unknown[] } } | undefined;
  if (provider?.meta?.status === false || ["provider_rejected", "invalid_payload", "invalid_signature", "expired_signature"].includes(String(result.error))) {
    throw new Error("sms_provider_rejected");
  }
  if (!response.ok || result.ok !== true) throw new Error("sms_delivery_unknown");
  const id = provider?.data?.message_outbox_ids?.[0];
  if (provider?.meta?.status !== true || (typeof id !== "string" && typeof id !== "number") || !/^[1-9]\d*$/.test(String(id))) {
    throw new Error("sms_delivery_unknown");
  }
  return String(id);
}

export async function notifyNewCustomer(customerId: number, options: NewCustomerNotificationOptions = {}): Promise<void> {
  const customer = queryRow<NotificationCustomer>(
    `SELECT c.id, c.name, c.phone, c.description,
       s.name AS salespersonName, s.mobile AS salespersonMobile
     FROM customers c
     LEFT JOIN salespersons s ON s.id = c.salesperson_id
     WHERE c.id = ?`,
    [customerId],
  );
  if (!customer) return;
  const settings = getNotificationSettings();
  const channels: Array<readonly ["telegram" | "ippanel", () => Promise<void>]> = [
    ["telegram", () => sendTelegram(customer, settings, options)],
  ];
  // Explicit opt-out only (website leads); any other value keeps the customer SMS.
  if (options.customerSms !== false) channels.push(["ippanel", () => sendIppanel(customer, settings)]);
  await Promise.all(channels.map(async ([channel, send]) => {
    try {
      await send();
    } catch (error) {
      recordDelivery(customer.id, channel, "failed", error instanceof Error ? error.message : "Unknown delivery error");
    }
  }));
}