import { createHmac, randomUUID } from "node:crypto";

type ProviderEnvelope = { data?: unknown; hasError?: boolean; messages?: unknown; error?: string };

export type Ics24Status = {
  status: string | null;
  statusTitle: string | null;
  reportLink: string | null;
  reportCode: string | null;
  reportTryCount: number | null;
  raw: ProviderEnvelope;
};

export type Ics24Summary = { score: number | null; scoreLabel: string | null; summary: string | null };

let tokenCache: { accessToken: string; refreshToken: string; apiKey: string; expiresAt: number } | undefined;
const timeoutMs = 20_000;

function baseUrl(): string {
  const value = process.env.ICS24_BASE_URL?.trim();
  if (!value) throw new Error("سرویس اعتبارسنجی تنظیم نشده است.");
  return value.replace(/\/+$/, "");
}
function bridgeUrl(): string | undefined {
  const value = process.env.ICS24_BRIDGE_URL?.trim();
  return value ? value.replace(/\/+$/, "") : undefined;
}
function message(value: unknown): string {
  if (typeof value === "string") return value.slice(0, 240);
  if (Array.isArray(value)) return value.map(message).join("، ").slice(0, 240);
  if (value && typeof value === "object") {
    const item = value as Record<string, unknown>;
    if (typeof item.message === "string") return item.message.slice(0, 240);
    if (typeof item.reason === "string") return item.reason.slice(0, 240);
  }
  return "خطای نامشخص سرویس اعتبارسنجی";
}
async function request(path: string, init: RequestInit): Promise<ProviderEnvelope> {
  const response = await fetch(`${baseUrl()}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  let body: ProviderEnvelope;
  try { body = await response.json() as ProviderEnvelope; } catch { throw new Error(`پاسخ نامعتبر سرویس اعتبارسنجی (${response.status})`); }
  if (response.status === 401) throw new Error("نشست سرویس اعتبارسنجی منقضی شده است.");
  if (!response.ok || body.hasError === true) throw new Error(message(body.messages) || `خطای سرویس (${response.status})`);
  return body;
}
async function bridgeRequest(path: string, method: string, body?: Record<string, string>): Promise<ProviderEnvelope> {
  const url = bridgeUrl();
  if (!url) throw new Error("پروکسی سرویس اعتبارسنجی تنظیم نشده است.");
  const keyId = process.env.ICS24_BRIDGE_KEY_ID?.trim();
  const secret = process.env.ICS24_BRIDGE_SHARED_SECRET;
  if (!keyId || !secret) throw new Error("کلید ارتباط با پروکسی اعتبارسنجی تنظیم نشده است.");
  const rawBody = body ? JSON.stringify(body) : "";
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = randomUUID();
  // IIS/Plesk exposes REQUEST_URI to PHP with percent-encoded path segments decoded.
  // Sign the same path representation the bridge receives so Base64 provider IDs
  // ending in "=" do not produce different HMAC inputs on each side.
  const canonicalPath = decodeURIComponent(path);
  const canonical = `${timestamp}\n${nonce}\n${method}\n${canonicalPath}\n${rawBody}`;
  const signature = createHmac("sha256", secret).update(canonical).digest("hex");
  const response = await fetch(`${url}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Bridge-Key": keyId,
      "X-Bridge-Timestamp": timestamp,
      "X-Bridge-Nonce": nonce,
      "X-Bridge-Signature": signature,
    },
    body: rawBody || undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  let result: ProviderEnvelope & { error?: string };
  try { result = await response.json() as ProviderEnvelope & { error?: string }; }
  catch { throw new Error(`پاسخ نامعتبر پروکسی اعتبارسنجی (${response.status})`); }
  if (!response.ok || result.hasError === true) {
    throw new Error(typeof result.error === "string" ? result.error.slice(0, 240) : message(result.messages) || `خطای پروکسی (${response.status})`);
  }
  return result;
}
async function login(): Promise<NonNullable<typeof tokenCache>> {
  const username = process.env.ICS24_USERNAME;
  const password = process.env.ICS24_PASSWORD;
  if (!username || !password) throw new Error("اطلاعات ورود سرویس اعتبارسنجی تنظیم نشده است.");
  const form = new URLSearchParams({ Username: username, Password: password });
  const body = await request("/Connect/Token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form });
  const data = body.data as Record<string, unknown> | undefined;
  if (!data?.accessToken || !data.refreshToken || !data.apiKey) throw new Error("پاسخ ورود سرویس اعتبارسنجی ناقص است.");
  return { accessToken: String(data.accessToken), refreshToken: String(data.refreshToken), apiKey: String(data.apiKey), expiresAt: Date.now() + 11 * 60 * 60 * 1000 };
}
async function auth(): Promise<NonNullable<typeof tokenCache>> {
  if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000) return tokenCache;
  if (tokenCache) {
    try {
      const form = new URLSearchParams({ AccessToken: tokenCache.accessToken, RefreshToken: tokenCache.refreshToken });
      const body = await request("/Connect/Token", { method: "PUT", headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Bearer ${tokenCache.accessToken}` }, body: form });
      const data = body.data as Record<string, unknown> | undefined;
      if (data?.accessToken) {
        tokenCache = { ...tokenCache, accessToken: String(data.accessToken), refreshToken: data.refreshToken ? String(data.refreshToken) : tokenCache.refreshToken, expiresAt: Date.now() + 11 * 60 * 60 * 1000 };
        return tokenCache;
      }
    } catch { tokenCache = undefined; }
  }
  tokenCache = await login();
  return tokenCache;
}
async function call(path: string, method: string, body?: Record<string, string>): Promise<ProviderEnvelope> {
  let credentials = await auth();
  const headers: Record<string, string> = { Authorization: `Bearer ${credentials.accessToken}`, "x-apikey": credentials.apiKey, "x-version": "3.1" };
  if (body) headers["Content-Type"] = "application/x-www-form-urlencoded";
  try {
    return await request(path, { method, headers, body: body ? new URLSearchParams(body) : undefined });
  } catch (error) {
    if (error instanceof Error && error.message.includes("منقضی")) {
      tokenCache = undefined; credentials = await auth();
      headers.Authorization = `Bearer ${credentials.accessToken}`;
      return request(path, { method, headers, body: body ? new URLSearchParams(body) : undefined });
    }
    throw error;
  }
}
export function normalizeMobile(value: string): string | undefined {
  const digits = normalizeDigits(value).replace(/\D/g, "");
  if (/^09\d{9}$/.test(digits)) return digits;
  if (/^989\d{9}$/.test(digits)) return `0${digits.slice(2)}`;
  return undefined;
}
export function normalizeDigits(value: string): string {
  return value
    .replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));
}
export function validNationalCode(value: string): boolean {
  const code = normalizeDigits(value).replace(/\D/g, "");
  if (!/^\d{10}$/.test(code) || /^(\d)\1{9}$/.test(code)) return false;
  const check = Number(code[9]);
  const sum = code.slice(0, 9).split("").reduce((n, d, i) => n + Number(d) * (10 - i), 0) % 11;
  return (sum < 2 ? sum : 11 - sum) === check;
}
export async function initiate(nationalCode: string, mobile: string) {
  const result = bridgeUrl()
    ? await bridgeRequest("/v1/credit-checks/initiate", "POST", { nationalCode, mobileNumber: mobile })
    : await call("/b2b/api/request", "POST", { RealPersonNationalCode: nationalCode, MobileNumber: mobile });
  if (typeof result.data !== "string") throw new Error("کد پیگیری سرویس اعتبارسنجی دریافت نشد.");
  return result.data;
}
export async function validate(hashCode: string, otp: string) {
  return bridgeUrl()
    ? bridgeRequest(`/v1/credit-checks/${encodeURIComponent(hashCode)}/validate`, "POST", { otp })
    : call(`/b2b/api/request/${encodeURIComponent(hashCode)}/validate`, "POST", { Token: otp });
}
export async function renew(hashCode: string) {
  return bridgeUrl()
    ? bridgeRequest(`/v1/credit-checks/${encodeURIComponent(hashCode)}/renew`, "POST")
    : call(`/b2b/api/request/${encodeURIComponent(hashCode)}/RenewToken`, "POST");
}
export async function status(hashCode: string): Promise<Ics24Status> {
  const raw = bridgeUrl()
    ? await bridgeRequest(`/v1/credit-checks/${encodeURIComponent(hashCode)}/status`, "GET")
    : await call(`/b2b/api/request/${encodeURIComponent(hashCode)}/status`, "GET");
  const data = (raw.data ?? {}) as Record<string, unknown>;
  const link = typeof data.reportLink === "string" ? data.reportLink : null;
  let reportCode: string | null = null;
  if (link) {
    try {
      const pathname = new URL(link, bridgeUrl() ?? baseUrl()).pathname;
      reportCode = pathname.split("/").filter(Boolean).pop() ?? null;
    } catch {
      reportCode = link.split("?")[0].split("/").filter(Boolean).pop() ?? null;
    }
  }
  return { status: typeof data.status === "string" ? data.status : null, statusTitle: typeof data.statusTitle === "string" ? data.statusTitle : null, reportLink: link, reportCode, reportTryCount: typeof data.reportTryCount === "number" ? data.reportTryCount : null, raw };
}

function primitive(object: unknown, keys: string[]): string | number | null {
  if (!object || typeof object !== "object") return null;
  const record = object as Record<string, unknown>;
  const normalizedKeys = new Set(keys.map((key) => key.toLowerCase()));
  for (const [key, value] of Object.entries(record)) {
    if (normalizedKeys.has(key.toLowerCase()) && (typeof value === "string" || typeof value === "number")) {
      return value;
    }
  }
  for (const value of Object.values(record)) {
    const nested = primitive(value, keys);
    if (nested != null) return nested;
  }
  return null;
}
type ScoreSection = { score: number | null; rank: string | number | null; priority: number };
const scoreKeys = ["score", "creditscore", "credit_score", "scorevalue", "score_value"];
const rankKeys = ["creditrank", "credit_rank", "rank", "grade", "rating", "scorelabel", "score_label"];
const ignoredSectionWords = ["guarantor", "facility", "component", "bank", "loan"];

function sectionScore(record: Record<string, unknown>, path: string): ScoreSection | null {
  const direct = (keys: string[]) => Object.entries(record).find(([key, value]) =>
    keys.includes(key.toLowerCase()) && (typeof value === "string" || typeof value === "number"))?.[1] as string | number | undefined;
  const scoreValue = direct(scoreKeys);
  if (scoreValue == null || !Number.isFinite(Number(scoreValue))) return null;
  const rank = direct(rankKeys) ?? direct(["title", "label", "statustitle"]) ?? null;
  const normalizedPath = path.toLowerCase();
  const explicitOverall = normalizedPath.includes("overall") || normalizedPath.includes("primary") || normalizedPath.includes("credit");
  const ignored = ignoredSectionWords.some((word) => normalizedPath.includes(word));
  return { score: Number(scoreValue), rank, priority: explicitOverall ? (ignored ? 1 : 3) : (ignored ? 0 : 2) };
}

function scoreSections(object: unknown, path = ""): ScoreSection[] {
  if (!object || typeof object !== "object") return [];
  if (Array.isArray(object)) {
    return object.flatMap((value, index) => scoreSections(value, `${path}[${index}]`));
  }
  const record = object as Record<string, unknown>;
  const current = sectionScore(record, path);
  const nested = Object.entries(record).flatMap(([key, value]) => scoreSections(value, `${path}.${key}`));
  return current ? [current, ...nested] : nested;
}

function explicitValue(object: unknown, keys: string[]): string | number | null {
  const candidates: Array<{ value: string | number; path: string }> = [];
  const visit = (value: unknown, path: string) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach((child, index) => visit(child, `${path}[${index}]`));
      return;
    }
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const childPath = `${path}.${key}`;
      if (keys.includes(key.toLowerCase()) && (typeof child === "string" || typeof child === "number")) candidates.push({ value: child, path: childPath });
      visit(child, childPath);
    }
  };
  visit(object, "");
  return candidates
    .sort((a, b) => Number(ignoredSectionWords.some((word) => a.path.toLowerCase().includes(word)))
      - Number(ignoredSectionWords.some((word) => b.path.toLowerCase().includes(word))))[0]?.value ?? null;
}

export async function report(reportCode: string): Promise<Ics24Summary> {
  const raw = bridgeUrl()
    ? await bridgeRequest(`/v1/reports/${encodeURIComponent(reportCode)}/json`, "GET")
    : await call(`/report/${encodeURIComponent(reportCode)}/json`, "GET");
  const data = (raw.data ?? {}) as Record<string, unknown>;
  const explicitScore = explicitValue(data, ["overallcreditscore", "overall_credit_score", "creditscore", "credit_score"]);
  const sections = scoreSections(data).sort((a, b) => b.priority - a.priority);
  const primary = sections[0];
  const scoreValue = explicitScore ?? primary?.score ?? primitive(data, scoreKeys);
  const score = scoreValue != null && Number.isFinite(Number(scoreValue)) ? Number(scoreValue) : null;
  const reportTypes = Array.isArray(data.reportTypes)
    ? data.reportTypes.filter((item): item is string => typeof item === "string")
    : [];
  const summary = reportTypes.length ? `بخش‌های گزارش: ${reportTypes.join("، ")}`.slice(0, 500) : null;
  return {
    score,
    // The provider's label is intentionally ignored. The CRM derives its
    // authoritative rank from score after receiving this report.
    scoreLabel: null,
    summary,
  };
}

export async function reportPdf(reportCode: string): Promise<Uint8Array> {
  const url = bridgeUrl();
  if (url) {
    const keyId = process.env.ICS24_BRIDGE_KEY_ID?.trim();
    const secret = process.env.ICS24_BRIDGE_SHARED_SECRET;
    if (!keyId || !secret) throw new Error("کلید ارتباط با پروکسی اعتبارسنجی تنظیم نشده است.");
    const path = `/v1/reports/${encodeURIComponent(reportCode)}/pdf`;
    const method = "GET";
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = randomUUID();
    const canonicalPath = decodeURIComponent(path);
    const signature = createHmac("sha256", secret).update(`${timestamp}\n${nonce}\n${method}\n${canonicalPath}\n`).digest("hex");
    const response = await fetch(`${url}${path}`, {
      method,
      headers: {
        "X-Bridge-Key": keyId,
        "X-Bridge-Timestamp": timestamp,
        "X-Bridge-Nonce": nonce,
        "X-Bridge-Signature": signature,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      let error = `خطای دریافت فایل گزارش (${response.status})`;
      try {
        const body = await response.json() as { error?: string };
        if (body.error) error = body.error;
      } catch { /* keep the HTTP error */ }
      throw new Error(error);
    }
    const payload = new Uint8Array(await response.arrayBuffer());
    if (hasPdfMagic(payload)) return payload;
    let envelope: { data?: unknown; error?: unknown } | null = null;
    try {
      envelope = JSON.parse(new TextDecoder().decode(payload)) as { data?: unknown; error?: unknown };
    } catch {
      // The final validation error below covers non-JSON, non-PDF responses.
    }
    if (envelope) {
      if (typeof envelope.data === "string") {
        const decoded = new Uint8Array(Buffer.from(envelope.data, "base64"));
        if (hasPdfMagic(decoded)) return decoded;
      }
      if (typeof envelope.error === "string") throw new Error(envelope.error);
    }
    throw new Error("محتوای PDF گزارش معتبر نیست.");
  }
  const credentials = await auth();
  const response = await fetch(`${baseUrl()}/b2b/api/request/${encodeURIComponent(reportCode)}/pdfReport`, {
    headers: { Authorization: `Bearer ${credentials.accessToken}`, "x-apikey": credentials.apiKey, "x-version": "3.1" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`خطای دریافت فایل گزارش (${response.status})`);
  const payload = new Uint8Array(await response.arrayBuffer());
  if (!hasPdfMagic(payload)) throw new Error("محتوای PDF گزارش معتبر نیست.");
  return payload;
}

function hasPdfMagic(payload: Uint8Array): boolean {
  return payload.length >= 5
    && payload[0] === 0x25
    && payload[1] === 0x50
    && payload[2] === 0x44
    && payload[3] === 0x46
    && payload[4] === 0x2d;
}