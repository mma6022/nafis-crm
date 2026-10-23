import { Router, type IRouter } from "express";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ListVoipRecordingsResponse } from "@workspace/api-zod";
import { requirePermission } from "../lib/access-control";
import type { AuthUser } from "../lib/auth";
import { queryRow, queryRows } from "../lib/crm-db";
import { findVoipCustomerByPhone } from "../lib/voip-customer-lookup";
import { crmDb } from "../lib/crm-db";
import { isExcludedCallPhone } from "../lib/call-display-exclusions";
import { CALL_LIST_FROM } from "../lib/call-list-cutoff";
import { callExtensions, callStartedAt, getSimotelAudio, getSimotelCalls, SimotelError, type SimotelCall } from "../lib/simotel";

const router: IRouter = Router();
const LIMIT = 20;
function normalizePhone(phone: string) {
  let value = phone.replace(/\D/g, "");
  if (value.startsWith("0098")) value = "0" + value.slice(4);
  else if (value.startsWith("98")) value = "0" + value.slice(2);
  else if (value.length === 10 && value.startsWith("9")) value = "0" + value;
  return /^0\d{9,10}$/.test(value) ? value : null;
}
function dateRange(query: Record<string, unknown>) {
  const today = new Date();
  const defaultFrom = CALL_LIST_FROM;
  const from = query.from ?? defaultFrom;
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone:"Asia/Tehran",year:"numeric",month:"2-digit",day:"2-digit" }).formatToParts(today);
  const to = query.to ?? ["year","month","day"].map(k=>parts.find(p=>p.type===k)!.value).join("-");
  const valid = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)
    && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v;
  if (!valid(from) || !valid(to) || from > to || Date.parse(to) - Date.parse(from) > 366 * 86400_000) {
    throw new SimotelError("invalid_range", 400, "بازهٔ تاریخ معتبر نیست؛ حداکثر یک سال انتخاب کنید.");
  }
  return { from, to };
}
function extensionFor(user: AuthUser) {
  const extension = queryRow<{ extension: string | null }>("SELECT extension FROM voip_extensions WHERE user_id=?", [user.id])?.extension ?? null;
  if (user.role !== "admin" && !extension) {
    throw new SimotelError("extension_required", 422, "مدیر سیستم باید داخلی تلفن را به حساب شما اختصاص دهد.");
  }
  return extension;
}
function customerFor(row: SimotelCall, user?: AuthUser) {
  // Never match an extension to a customer phone or broaden customer scope.
  const phone = row.type === "incoming" ? row.src : row.type === "outgoing" ? row.dst : null;
  const customer = phone ? findVoipCustomerByPhone(crmDb, phone, normalizePhone, null) : null;
  if (customer && user?.role !== "admin" && user?.customerScope === "assigned"
    && (user.salespersonId == null || queryRow<{ salesperson_id: number | null }>("SELECT salesperson_id FROM customers WHERE id=?", [customer.id])?.salesperson_id !== user.salespersonId)) return null;
  return customer;
}
function visible(row: SimotelCall, user: AuthUser, own: string | null) {
  if (isExcludedCallPhone(row.src) || isExcludedCallPhone(row.dst)) return false;
  if (user.role === "admin") return true;
  // Own PBX calls are visible independently of CRM ownership. Customer profile
  // metadata is separately redacted below; this does not grant profile access.
  return !!own && callExtensions(row, [own]).includes(own);
}
function handleError(res: import("express").Response, error: unknown) {
  if (res.headersSent) { res.destroy(); return; }
  const known = error instanceof SimotelError ? error : new SimotelError("report_failure", 502, "دریافت گزارش یا فایل صوتی ناموفق بود.");
  res.status(known.status).json({ code: known.code, error: known.message });
}
// Use the SAME authorization and authoritative provider lookup for text as audio.
export async function authorizedVoipRecording(id: string, range: Record<string, unknown>, user: AuthUser) {
  if (!/^[A-Za-z0-9_.-]{1,128}$/.test(id)) throw new SimotelError("invalid_id", 400, "شناسهٔ تماس معتبر نیست.");
  const { from, to } = dateRange(range), own = extensionFor(user);
  const { rows } = await getSimotelCalls(from, to);
  const row = rows.find(x => x._id === id && visible(x, user, own));
  if (!row?.record) throw new SimotelError("recording_missing", 404, "تماس ضبط‌شده در دسترس شما نیست.");
  return { row, from, to };
}

router.get("/voip/recordings", requirePermission("calls.view"), async (req, res) => {
  res.setHeader("Cache-Control", "private, no-store");
  try {
    const user = res.locals.authUser as AuthUser;
    const own = extensionFor(user);
    const range = dateRange(req.query);
    const from = range.from < CALL_LIST_FROM ? CALL_LIST_FROM : range.from, to = range.to;
    const page = Number(req.query.page ?? 1);
    const extension = req.query.extension;
    const phone = req.query.phone;
    const status = req.query.status;
    const recorded = req.query.recordedOnly;
    if (!Number.isSafeInteger(page) || page < 1 || page > 100000
      || (extension !== undefined && (typeof extension !== "string" || !/^[A-Za-z0-9*#_.-]{1,32}$/.test(extension)))
      || (phone !== undefined && (typeof phone !== "string" || !/^\+?[0-9]{2,32}$/.test(phone)))
      || (status !== undefined && !["ANSWERED", "NO ANSWER", "BUSY", "FAILED"].includes(String(status)))
      || (recorded !== undefined && recorded !== "true" && recorded !== "false")) {
      throw new SimotelError("invalid_filters", 400, "فیلترهای گزارش معتبر نیست.");
    }
    const { rows, fetchedAt } = to < CALL_LIST_FROM
      ? { rows: [] as SimotelCall[], fetchedAt: new Date().toISOString() }
      : await getSimotelCalls(from, to);
    const experts = queryRows<{ name: string; extension: string }>(
      "SELECT COALESCE(u.full_name,u.username) name,e.extension FROM voip_extensions e JOIN users u ON u.id=e.user_id WHERE e.extension IS NOT NULL",
    );
    const knownExtensions = experts.map(x => x.extension);
    const startsFrom = Date.parse(`${from}T00:00:00+03:30`);
    const endsBefore = Date.parse(`${to}T00:00:00+03:30`) + 86400_000;
    const matched = rows.filter(row => {
      const started = Date.parse(callStartedAt(row));
      return started >= startsFrom && started < endsBefore && visible(row, user, own)
      && (!extension || callExtensions(row, knownExtensions).includes(extension as string))
      && (!phone || row.src.includes(phone as string) || row.dst.includes(phone as string))
      && (!status || row.disposition === status)
      && (recorded !== "true" || !!row.record);
    });
    const items = matched.slice((page - 1) * LIMIT, page * LIMIT).map(row => {
      const extensions = callExtensions(row, knownExtensions);
      const customer = customerFor(row, user);
      return {
        id: row._id, source: "simotel" as const, fromNumber: row.src, toNumber: row.dst,
        direction: ["incoming", "outgoing", "local"].includes(row.type) ? row.type : "unknown",
        status: row.disposition, startedAt: callStartedAt(row),
        durationSeconds: Math.floor(row.duration), talkSeconds: Math.floor(row.billsec),
        extensions, expertNames: experts.filter(x => extensions.includes(x.extension)).map(x => x.name),
        hasRecording: !!row.record, customerId: customer?.id ?? null, customerName: customer?.name ?? null,
      };
    });
    res.json(ListVoipRecordingsResponse.parse({
      items, total: matched.length, recordedTotal: matched.filter(x => x.record).length,
      page, limit: LIMIT, from, to, canManage: user.role === "admin", ownExtension: own, fetchedAt,
    }));
  } catch (error) { handleError(res, error); }
});

router.get("/voip/recordings/:id/audio", requirePermission("calls.view"), async (req, res) => {
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  try {
    const user = res.locals.authUser as AuthUser;
    const own = extensionFor(user);
    const id = String(req.params.id);
    if (!/^[A-Za-z0-9_.-]{1,128}$/.test(id)) throw new SimotelError("invalid_id", 400, "شناسهٔ تماس معتبر نیست.");
    const { from, to } = dateRange(req.query);
    const { rows } = await getSimotelCalls(from, to);
    const row = rows.find(x => x._id === id && visible(x, user, own));
    if (!row?.record) throw new SimotelError("recording_missing", 404, "تماس یا فایل صوتی در دسترس شما نیست.");
    const response = await getSimotelAudio(row.record);
    res.setHeader("Content-Type", response.headers.get("content-type")!);
    const suffix = row.record.split(".").pop()!.toLowerCase();
    res.setHeader("Content-Disposition", `attachment; filename="call-${id}.${suffix}"`);
    const source = Readable.fromWeb(response.body as any);
    const abort = () => source.destroy();
    res.on("close", abort);
    let bytes = 0;
    const guard = new Transform({ transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      callback(bytes > 100 * 1024 * 1024 ? new Error("audio_size_limit") : null, chunk);
    } });
    try { await pipeline(source, guard, res); }
    finally { res.off("close", abort); }
  } catch (error) { handleError(res, error); }
});

export default router;