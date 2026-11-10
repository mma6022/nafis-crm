import { isIP } from "node:net";

/**
 * Forwards saved «گزارش خطا» reports to an external webhook.
 * Fire-and-forget: callers never await delivery and a failure can never
 * affect the stored report. URL and key come only from process env
 * (REPORT_WEBHOOK_URL, REPORT_WEBHOOK_KEY, optional REPORT_WEBHOOK_KEY_HEADER).
 * Secrets are never logged. Payload is limited to report text, page, user
 * id/role, timestamp, and build RID; phones and national ids are not included.
 */
export type ReportWebhookPayload = {
  type: "nafis.bug_report.created";
  schemaVersion: 1;
  report: {
    id: number;
    text: string;
    page: string;
    createdAt: string;
    release: string | null;
  };
  reporter: { id: number; role: string };
};

export type WebhookConfig = { url: string; key: string; header: string };
export type ForwardResult = { delivered: boolean; attempts: number; status?: number; error?: string };
type Log = { info: (o: object, m: string) => void; warn: (o: object, m: string) => void; error: (o: object, m: string) => void };

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;

/** Returns null (forwarding disabled) unless URL+key are present and safe. */
export function webhookConfigFromEnv(env: NodeJS.ProcessEnv = process.env): WebhookConfig | null {
  const raw = env.REPORT_WEBHOOK_URL?.trim(), key = env.REPORT_WEBHOOK_KEY?.trim();
  if (!raw || !key) return null;
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  const loopback = LOOPBACK.has(url.hostname) || (isIP(url.hostname) !== 0 && url.hostname.startsWith("127."));
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return null;
  if (url.username || url.password) return null;
  const header = env.REPORT_WEBHOOK_KEY_HEADER?.trim() || "Authorization";
  if (!HEADER_NAME.test(header)) return null;
  return { url: url.href, key, header };
}

/** Default: `Authorization: Bearer <key>`. Any other header name carries the raw key. */
export function authHeaders(config: WebhookConfig): Record<string, string> {
  return config.header.toLowerCase() === "authorization"
    ? { Authorization: `Bearer ${config.key}` }
    : { [config.header]: config.key };
}

const retryable = (status: number) => status === 408 || status === 425 || status === 429 || status >= 500;
/** Origin + pathname only — never query, userinfo, or the key. */
const safeTarget = (href: string) => { try { const u = new URL(href); return u.origin + u.pathname; } catch { return "invalid"; } };

export function createReportForwarder(options: {
  config: () => WebhookConfig | null;
  fetch?: typeof fetch;
  log: Log;
  delaysMs?: number[];
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  onResult?: (reportId: number, result: ForwardResult) => void;
}) {
  const doFetch = options.fetch ?? fetch;
  const delays = options.delaysMs ?? [2_000, 8_000]; // 3 tries total: now, +2s, +8s
  const timeoutMs = options.timeoutMs ?? 10_000;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms).unref?.()));

  async function deliver(payload: ReportWebhookPayload): Promise<ForwardResult> {
    const config = options.config();
    if (!config) return { delivered: false, attempts: 0, error: "webhook_not_configured" };
    const body = JSON.stringify(payload);
    const target = safeTarget(config.url);
    let last: ForwardResult = { delivered: false, attempts: 0 };
    for (let attempt = 1; attempt <= delays.length + 1; attempt++) {
      try {
        const res = await doFetch(config.url, {
          method: "POST", redirect: "manual", signal: AbortSignal.timeout(timeoutMs),
          headers: { "Content-Type": "application/json", "User-Agent": "nafis-crm-report-webhook/1",
            "X-Nafis-Event": payload.type, "X-Nafis-Report-Id": String(payload.report.id),
            "Idempotency-Key": `nafis-report-${payload.report.id}`, ...authHeaders(config) },
          body,
        });
        await res.arrayBuffer().catch(() => undefined);
        if (res.status >= 200 && res.status < 300) {
          options.log.info({ reportId: payload.report.id, attempt, status: res.status, target }, "report_webhook_delivered");
          return { delivered: true, attempts: attempt, status: res.status };
        }
        last = { delivered: false, attempts: attempt, status: res.status, error: `http_${res.status}` };
        if (!retryable(res.status)) break;
      } catch (error) {
        const name = error instanceof Error ? error.name : "Error";
        last = { delivered: false, attempts: attempt, error: name === "TimeoutError" ? "timeout" : "network_error" };
      }
      options.log.warn({ reportId: payload.report.id, attempt, status: last.status, error: last.error, target }, "report_webhook_attempt_failed");
      if (attempt <= delays.length) await sleep(delays[attempt - 1]);
    }
    options.log.error({ reportId: payload.report.id, attempts: last.attempts, status: last.status, error: last.error, target }, "report_webhook_failed");
    return last;
  }

  return {
    enabled: () => options.config() !== null,
    deliver,
    /** Never throws, never awaited by the request path. */
    forward(payload: ReportWebhookPayload, onResult = options.onResult): void {
      void deliver(payload)
        .then(result => { try { onResult?.(payload.report.id, result); } catch (error) {
          options.log.error({ reportId: payload.report.id, err: String(error) }, "report_webhook_state_write_failed"); } })
        .catch(error => options.log.error({ reportId: payload.report.id, err: String(error) }, "report_webhook_unexpected"));
    },
  };
}
export type ReportForwarder = ReturnType<typeof createReportForwarder>;
