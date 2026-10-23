import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";

export type SimotelCall = {
  _id: string; cuid: string; src: string; dst: string; type: string;
  start?: string; starttime?: string; duration: number; billsec: number;
  endtime?: { $date?: { $numberLong?: string } };
  disposition: string; record?: string;
  details?: Array<{ exten?: string; status?: string }>;
};
export class SimotelError extends Error {
  constructor(public code: string, public status: number, message: string) { super(message); }
}
const API_ORIGIN = "https://panel.hostedpbx.ir";
const AUDIO_ORIGIN = "https://storage.hostedpbx.ir";
const MAX_JSON = 4 * 1024 * 1024;
const cache = new Map<string, { expires: number; complete: boolean; value: Promise<{ rows: SimotelCall[]; fetchedAt: string }> }>();
export function invalidateSimotelCallCache() { cache.clear(); }

// The development container cannot reach this provider directly. An optional
// localhost-only SSH TCP forward preserves end-to-end hostname-verified TLS.
// Production never uses this override.
async function providerFetch(url: URL, init: RequestInit = {}): Promise<Response> {
  const port = process.env.NODE_ENV === "development"
    ? process.env[url.origin === API_ORIGIN ? "SIMOTEL_TUNNEL_API_PORT" : "SIMOTEL_TUNNEL_AUDIO_PORT"]
    : undefined;
  if (!port) return fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(30_000) });
  if (!/^\d{4,5}$/.test(port)) throw new SimotelError("configuration", 503, "تنظیمات اتصال سیموتل معتبر نیست.");
  return new Promise((resolve, reject) => {
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const req = httpsRequest({
      hostname: "127.0.0.1", port: Number(port), servername: url.hostname,
      path: `${url.pathname}${url.search}`, method: init.method ?? "GET",
      headers: { ...headers, Host: url.host }, signal: AbortSignal.timeout(30_000),
    }, (res) => {
      const responseHeaders = new Headers();
      for (const [key, value] of Object.entries(res.headers)) {
        if (value !== undefined) responseHeaders.set(key, Array.isArray(value) ? value.join(", ") : value);
      }
      resolve(new Response(Readable.toWeb(res) as ReadableStream, {
        status: res.statusCode ?? 502, headers: responseHeaders,
      }));
    });
    req.on("error", reject);
    req.end(typeof init.body === "string" ? init.body : undefined);
  });
}

async function jsonBody(response: Response): Promise<any> {
  const reader = response.body?.getReader();
  if (!reader) throw new SimotelError("invalid_response", 502, "پاسخ سیموتل معتبر نیست.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_JSON) throw new SimotelError("invalid_response", 502, "پاسخ سیموتل بیش از حد بزرگ است.");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (error instanceof SimotelError) throw error;
    throw new SimotelError("invalid_response", 502, "پاسخ سیموتل معتبر نیست.");
  }
}

function checkStatus(response: Response) {
  if (response.ok) return;
  void response.body?.cancel().catch(() => {});
  if ([401, 403].includes(response.status)) {
    throw new SimotelError("provider_access", 502, "سیموتل دسترسی حساب API یا IP سرور را نپذیرفت.");
  }
  if (response.status === 404) throw new SimotelError("recording_missing", 404, "فایل صوتی در مرکز تماس پیدا نشد.");
  throw new SimotelError("provider_failure", 502, "دریافت اطلاعات از سیموتل ناموفق بود.");
}

async function api(path: "reports/cdr/search" | "reports/audio/download", body: object) {
  const key = process.env.SIMOTEL_API_KEY;
  if (!key) throw new SimotelError("not_configured", 503, "کلید API سیموتل روی سرور تنظیم نشده است.");
  // Do not accept a destination or arbitrary path from a browser request.
  try {
    const response = await providerFetch(new URL(`/api/v4.1/${path}`, API_ORIGIN), {
      method: "POST", headers: { "X-APIKEY": key, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    checkStatus(response);
    return response;
  } catch (error) {
    if (error instanceof SimotelError) throw error;
    // Never expose upstream URLs, signed links, credentials or network errors.
    throw new SimotelError("unavailable", 503, "ارتباط با مرکز تماس برقرار نشد؛ دوباره تلاش کنید.");
  }
}

export function validateCall(value: unknown): value is SimotelCall {
  if (!value || typeof value !== "object") return false;
  const v = value as SimotelCall;
  return typeof v._id === "string" && /^[A-Za-z0-9_.-]{1,128}$/.test(v._id)
    && typeof v.cuid === "string" && typeof v.src === "string" && typeof v.dst === "string"
    && typeof v.disposition === "string" && typeof v.type === "string"
    && Number.isFinite(v.duration) && v.duration >= 0 && Number.isFinite(v.billsec) && v.billsec >= 0
    && (v.record === undefined || typeof v.record === "string")
    && (v.details === undefined || (Array.isArray(v.details) && v.details.every(x =>
      x && typeof x === "object" && (x.exten === undefined || typeof x.exten === "string")
      && (x.status === undefined || typeof x.status === "string"))));
}

async function loadCalls(from: string, to: string) {
  const rows: SimotelCall[] = [];
  const ids = new Set<string>();
  let total: number | undefined;
  for (let start = 0; start < 5000; start += 100) {
    const data = await jsonBody(await api("reports/cdr/search", {
      conditions: { from: "", to: "", cuid: "" },
      date_range: { from: `${from} 00:00`, to: `${to} 23:59` },
      pagination: { start, count: 100, sorting: { starttime: -1 } }, alike: "true",
    }));
    if (data?.success !== 1) throw new SimotelError("provider_failure", 502, "سیموتل گزارش تماس را برنگرداند.");
    const batch = data.data?.data;
    const count = data.data?.pagination?.total;
    if (!Array.isArray(batch) || !Number.isSafeInteger(count) || count < 0 || !batch.every(validateCall)) {
      throw new SimotelError("invalid_response", 502, "ساختار گزارش سیموتل معتبر نیست.");
    }
    if (count > 5000) throw new SimotelError("range_too_large", 422, "تعداد تماس‌ها زیاد است؛ بازهٔ تاریخ را کوتاه‌تر کنید.");
    if (total !== undefined && total !== count) {
      throw new SimotelError("report_changed", 503, "گزارش هنگام دریافت تغییر کرد؛ دوباره تازه‌سازی کنید.");
    }
    total = count;
    for (const row of batch) {
      if (ids.has(row._id)) throw new SimotelError("report_changed", 503, "گزارش هنگام دریافت تغییر کرد؛ دوباره تازه‌سازی کنید.");
      ids.add(row._id); rows.push(row);
    }
    if (rows.length === total) return { rows, fetchedAt: new Date().toISOString() };
    if (!batch.length || rows.length > count) break;
  }
  throw new SimotelError("incomplete_report", 502, "گزارش کامل دریافت نشد؛ بازهٔ تاریخ را کوتاه‌تر کنید.");
}

export function getSimotelCalls(from: string, to: string, fresh = false) {
  const key = `${from}/${to}`;
  const hit = cache.get(key);
  if (hit && ((!fresh && hit.expires > Date.now()) || !hit.complete)) return hit.value;
  if (cache.size >= 8) cache.delete(cache.keys().next().value!);
  const entry = { expires: Date.now() + 60_000, complete: false, value: null as unknown as Promise<{ rows: SimotelCall[]; fetchedAt: string }> };
  const value = loadCalls(from, to).then(result => { entry.complete = true; return result; }).catch(error => {
    if (cache.get(key)?.value === value) cache.delete(key);
    throw error;
  });
  entry.value = value;
  cache.set(key, entry);
  return value;
}

export function callExtensions(row: SimotelCall, knownExtensions: string[] = []): string[] {
  const endpoints = [row.src, row.dst].filter(x =>
    /^[A-Za-z0-9*#_.-]{1,6}$/.test(x) || knownExtensions.includes(x));
  const answered = (row.details ?? []).filter(x => x.status === "ANSWERED")
    .map(x => x.exten ?? "").filter(x => /^[A-Za-z0-9*#_.-]{1,32}$/.test(x));
  return [...new Set([...endpoints, ...answered])];
}

export function callStartedAt(row: SimotelCall): string {
  // v4.1 starttime is Jalali; endtime is a MongoDB UTC epoch wrapper.
  // Never parse the Jalali year as Gregorian in JavaScript Date.
  if (row.start && /^(19|20)\d{2}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(row.start)) {
    const value = Date.parse(row.start.replace(" ", "T") + (/[Z+]/.test(row.start) ? "" : "+03:30"));
    if (Number.isFinite(value)) return new Date(value).toISOString();
  }
  const end = Number(row.endtime?.$date?.$numberLong);
  if (Number.isFinite(end) && end > 0) return new Date(end - row.duration * 1000).toISOString();
  throw new SimotelError("invalid_response", 502, "زمان ثبت تماس در گزارش معتبر نیست.");
}

export async function getSimotelAudio(file: string): Promise<Response> {
  if (!/^[A-Za-z0-9_.-]{1,255}\.(mp3|wav|ogg|gsm)$/i.test(file) || file.includes("..")) {
    throw new SimotelError("invalid_recording", 502, "نام فایل ضبط‌شده معتبر نیست.");
  }
  let response = await api("reports/audio/download", { file });
  if (response.headers.get("content-type")?.includes("json")) {
    const data = await jsonBody(response);
    if (data?.success !== 1) throw new SimotelError("recording_missing", 404, "فایل صوتی در مرکز تماس موجود نیست.");
    let url: URL;
    try { url = new URL(data?.data?.audioLink); }
    catch { throw new SimotelError("invalid_response", 502, "لینک فایل صوتی معتبر نیست."); }
    // Exact-origin allowlist prevents SSRF and never follows signed-link redirects.
    if (url.origin !== AUDIO_ORIGIN || url.username || url.password || url.hash) {
      throw new SimotelError("invalid_response", 502, "نشانی فایل صوتی سیموتل مجاز نیست.");
    }
    try { response = await providerFetch(url); }
    catch { throw new SimotelError("unavailable", 503, "دریافت فایل صوتی از مرکز تماس ناموفق بود."); }
    checkStatus(response);
  }
  const type = response.headers.get("content-type")?.split(";")[0]?.toLowerCase();
  if (!type || (!type.startsWith("audio/") && type !== "application/octet-stream")
    || Number(response.headers.get("content-length")) > 100 * 1024 * 1024 || !response.body) {
    void response.body?.cancel().catch(() => {});
    throw new SimotelError("invalid_audio", 502, "پاسخ مرکز تماس فایل صوتی معتبر نیست.");
  }
  return response;
}