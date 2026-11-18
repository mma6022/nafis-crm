/** Safe download filename for a Simotel call recording. Never includes a phone or customer name. */
export function tehranCalendarDay(at: string | Date): string {
  const value = at instanceof Date ? at : new Date(at);
  if (!Number.isFinite(value.getTime())) throw new Error("invalid_time");
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tehran", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(value);
  return ["year", "month", "day"].map((k) => parts.find((p) => p.type === k)!.value).join("-");
}

export function recordingFileExtension(recordPath: string): string {
  const ext = (recordPath.split(".").pop() ?? "mp3").toLowerCase();
  return /^[a-z0-9]{1,8}$/.test(ext) ? ext : "mp3";
}

export function recordingDownloadFilename(callId: string | number, startedAt: string | Date, recordPath: string): string {
  let id = String(callId).replace(/[^A-Za-z0-9_.-]/g, "");
  while (id.includes("..")) id = id.replace(/\.\./g, "");
  id = id.replace(/^[.-]+|[.-]+$/g, "").slice(0, 128) || "call";
  const day = tehranCalendarDay(startedAt);
  return `call-${id}-${day}.${recordingFileExtension(recordPath)}`;
}

export function recordingDownloadDisposition(filename: string): string {
  // ASCII-only filename; no phone or customer name is ever interpolated here.
  if (!/^call-[A-Za-z0-9_.-]+-\d{4}-\d{2}-\d{2}\.[A-Za-z0-9]{1,8}$/.test(filename)
    || /09\d{8}/.test(filename) || /[\u0600-\u06FF]/.test(filename)) {
    throw new Error("invalid_filename");
  }
  return `attachment; filename="${filename}"`;
}
