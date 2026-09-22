import { createHmac } from "node:crypto";
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

function normalizeIranianMobile(value: string): string | undefined {
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

async function sendTelegram(customer: NotificationCustomer, settings: NotificationSettings): Promise<void> {
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
      text: fillTemplate(settings.telegramMessageTemplate, customer),
    }),
  });
  if (!response.ok) throw new Error(`Telegram returned HTTP ${response.status}`);
  recordDelivery(customer.id, "telegram", "sent");
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
    response = await fetch(relayUrl, {
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

export async function notifyNewCustomer(customerId: number): Promise<void> {
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
  const channels = [
    ["telegram", () => sendTelegram(customer, settings)],
    ["ippanel", () => sendIppanel(customer, settings)],
  ] as const;
  await Promise.all(channels.map(async ([channel, send]) => {
    try {
      await send();
    } catch (error) {
      recordDelivery(customer.id, channel, "failed", error instanceof Error ? error.message : "Unknown delivery error");
    }
  }));
}