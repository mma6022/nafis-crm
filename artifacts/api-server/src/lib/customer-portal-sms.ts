import { createHmac } from "node:crypto";
import { smsFetch } from "./sms-proxy";
import { getNotificationSettings, normalizeIranianMobile } from "./customer-notifications";

const OTP_PATTERN_CODE = "7ztdnd9x3l";

function localRelayUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("sms_relay_not_configured");
  }
  const localHosts = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !localHosts.has(url.hostname.toLowerCase()) ||
    url.username ||
    url.password
  ) {
    throw new Error("sms_relay_not_configured");
  }
  return url;
}

export async function sendCustomerPortalOtp(mobile: string, code: string): Promise<void> {
  const settings = getNotificationSettings();
  if (!settings.ippanelEnabled) throw new Error("sms_disabled");
  const relaySecret = process.env.IR_RELAY_SHARED_SECRET;
  if (!relaySecret) throw new Error("sms_relay_not_configured");
  const relayUrl = localRelayUrl(settings.ippanelRelayUrl);
  const recipient = normalizeIranianMobile(mobile);
  if (!recipient) throw new Error("invalid_phone");

  const body = JSON.stringify({
    sending_type: "pattern",
    from_number: settings.ippanelFromNumber,
    code: OTP_PATTERN_CODE,
    recipients: [recipient],
    params: { code },
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", relaySecret)
    .update(`${timestamp}.${body}`)
    .digest("hex");
  let response: Response;
  try {
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
    throw new Error("sms_delivery_failed");
  }
  let result: Record<string, unknown>;
  try {
    result = await response.json() as Record<string, unknown>;
  } catch {
    throw new Error("sms_delivery_failed");
  }
  if (!response.ok || result.ok !== true) throw new Error("sms_delivery_failed");
}