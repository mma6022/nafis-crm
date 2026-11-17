/**
 * Emzame POST /files rejects a form `name` (and the derived filename) that is
 * too long: every live success was ≤63 characters and ≤111 UTF-8 bytes;
 * every provider_file_upload_failed title was ≥80 characters / ≥146 bytes.
 * Plan 25 «سپهر…» is 77 characters by itself, so «قرارداد طرح ${plan} - ${customer}»
 * never fits. Truncate without changing loan_plans or contract text.
 */
export const PROVIDER_TITLE_MAX_CHARS = 63;
export const PROVIDER_TITLE_MAX_BYTES = 111;

export function clipProviderText(value: string, maxChars = PROVIDER_TITLE_MAX_CHARS, maxBytes = PROVIDER_TITLE_MAX_BYTES): string {
  let out = "";
  for (const ch of [...value]) {
    const next = out + ch;
    if ([...next].length > maxChars || Buffer.byteLength(next, "utf8") > maxBytes) break;
    out = next;
  }
  return out;
}

export function providerContractTitle(planName: string, customerName: string): string {
  const plan = String(planName || "").replace(/\s+/g, " ").trim() || "وام";
  const customer = String(customerName || "").replace(/\s+/g, " ").trim() || "مشتری";
  const prefix = "قرارداد طرح ";
  const mid = " - ";
  const full = `${prefix}${plan}${mid}${customer}`;
  if ([...full].length <= PROVIDER_TITLE_MAX_CHARS && Buffer.byteLength(full, "utf8") <= PROVIDER_TITLE_MAX_BYTES) return full;
  // Keep the prefix, then give the plan name the first share of the leftover room
  // so «سپهر» stays readable, and leave the rest for the customer name.
  const leftoverChars = Math.max(8, PROVIDER_TITLE_MAX_CHARS - [...prefix].length);
  const leftoverBytes = Math.max(16, PROVIDER_TITLE_MAX_BYTES - Buffer.byteLength(prefix, "utf8"));
  const planShareChars = Math.max(4, Math.floor(leftoverChars * 0.55));
  const planShareBytes = Math.max(8, Math.floor(leftoverBytes * 0.55));
  const planPart = clipProviderText(plan, planShareChars, planShareBytes);
  const usedChars = [...prefix].length + [...planPart].length + [...mid].length;
  const usedBytes = Buffer.byteLength(prefix + planPart + mid, "utf8");
  const customerPart = clipProviderText(customer, PROVIDER_TITLE_MAX_CHARS - usedChars, PROVIDER_TITLE_MAX_BYTES - usedBytes);
  return clipProviderText(`${prefix}${planPart}${mid}${customerPart}`);
}

export function safeProviderPdfFilename(title: string, fallback: string): string {
  const basename = clipProviderText(
    title
      .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, "_")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/[. ]+$/g, ""),
    63,
    111,
  );
  const stem = basename || clipProviderText(fallback, 40, 80) || "contract";
  return `${stem}.pdf`;
}

/** Read a short provider error, including errorCode when the message fields are empty. */
export function providerErrorMessage(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const record = body as Record<string, unknown>;
  for (const key of ["persianMessage", "message", "detail"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim() && value.length <= 500) return value.trim();
  }
  const code = record.errorCode ?? record.error_code ?? record.code;
  if (typeof code === "string" && code.trim() && code.length <= 120) return code.trim();
  if (typeof code === "number" && Number.isFinite(code)) return String(code);
  return undefined;
}
