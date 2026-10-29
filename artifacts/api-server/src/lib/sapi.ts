import { createHmac } from "node:crypto";
import { identityEgress, sapiViaProxy } from "./identity-egress";

type SapiCheck = "shahkarLite" | "personInfo" | "postalCodeInfo" | "sana";

export type SapiVerificationInput = {
  nationalCode: string;
  mobile: string;
  birthDateJalali?: string | null;
  postalCode?: string | null;
  name?: string | null;
  fatherName?: string | null;
};

export type SapiVerificationResult = {
  status: "verified" | "failed";
  checks: Record<SapiCheck, { ok: boolean; providerStatus?: string; completed?: boolean }>;
  canonical: Record<string, string>;
  error?: string;
};

const checks: SapiCheck[] = ["shahkarLite", "personInfo", "postalCodeInfo", "sana"];

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function success(value: unknown): boolean {
  const item = asRecord(value);
  if (item.success === true || item.isSuccess === true || item.valid === true) return true;
  const status = String(item.status ?? item.result ?? item.code ?? "").toLowerCase();
  return ["ok", "success", "successful", "verified", "true", "200"].includes(status);
}

function findString(value: unknown, aliases: string[], depth = 0): string | undefined {
  if (depth > 5 || !value || typeof value !== "object") return undefined;
  const normalizedAliases = new Set(aliases.map((key) => key.replace(/[_-]/g, "").toLowerCase()));
  const entries = Array.isArray(value)
    ? value.map((item, index) => [String(index), item] as const)
    : Object.entries(value as Record<string, unknown>);
  for (const [key, item] of entries) {
    const normalizedKey = key.replace(/[_-]/g, "").toLowerCase();
    if (normalizedAliases.has(normalizedKey) && typeof item === "string" && item.trim()) {
      return item.trim();
    }
  }
  for (const [, item] of entries) {
    const nested = findString(item, aliases, depth + 1);
    if (nested) return nested;
  }
  return undefined;
}

const directPaths: Record<SapiCheck, string> = {
  shahkarLite: "api/sw1/ShahkarLite",
  personInfo: "api/sw1/PersonInfo",
  postalCodeInfo: "api/sw1/PostalCodeInfo",
  sana: "api/sw1/Sana",
};

async function call(pathname: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (identityEgress() === "proxy") {
    // identity_egress='proxy' (t687s2662): direct s.api.ir through the Iran proxy, relay not used.
    const direct = directPaths[pathname as SapiCheck];
    if (!direct) throw new Error("SAPI request failed (unknown_check)");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12_000);
    try {
      const r = await sapiViaProxy(direct, JSON.stringify(payload), { signal: controller.signal });
      let body: unknown = {};
      try { body = JSON.parse(r.text); } catch { body = {}; }
      if (r.status < 200 || r.status >= 300) throw new Error(`SAPI request failed (${r.status})`);
      return asRecord(body);
    } finally {
      clearTimeout(timeout);
    }
  }
  const relayBase = process.env.SAPI_RELAY_URL;
  const relaySecret = process.env.IR_RELAY_SHARED_SECRET;
  const requestBody = JSON.stringify(payload);
  const headers: Record<string, string> = { "content-type": "application/json" };
  let url: string;
  if (relayBase) {
    if (!relaySecret) throw new Error("SAPI relay signing secret is not configured");
    const timestamp = String(Math.floor(Date.now() / 1000));
    headers["X-Relay-Timestamp"] = timestamp;
    headers["X-Relay-Signature"] = createHmac("sha256", relaySecret)
      .update(`${timestamp}.${requestBody}`)
      .digest("hex");
    url = `${relayBase.replace(/\/$/, "")}/${pathname}`;
  } else {
  const base = process.env.SAPI_API_BASE_URL || "https://s.api.ir";
  const token = process.env.SAPI_API_TOKEN;
  if (!base || !token) throw new Error("SAPI provider is not configured");
    headers.authorization = `Bearer ${token}`;
    url = `${base.replace(/\/$/, "")}/${directPaths[pathname as SapiCheck] ?? pathname.replace(/^\//, "")}`;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: requestBody,
      signal: controller.signal,
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`SAPI request failed (${response.status})`);
    return asRecord(body);
  } finally {
    clearTimeout(timeout);
  }
}

export async function verifyCustomer(
  input: SapiVerificationInput,
  retained: Partial<SapiVerificationResult["checks"]> = {},
  selectedChecks: readonly SapiCheck[] = checks,
): Promise<SapiVerificationResult> {
  const mobile = input.mobile
    .replace(/\D/g, "")
    .replace(/^0098/, "0")
    .replace(/^98/, "0");
  const payloads: Record<SapiCheck, Record<string, unknown>> = {
    shahkarLite: { nationalCode: input.nationalCode, mobile },
    personInfo: {
      nationalCode: input.nationalCode,
      birthDate: input.birthDateJalali?.replace(/\/0(?=\d)/g, "/"),
    },
    postalCodeInfo: { postalCode: input.postalCode },
    sana: { nationalCode: input.nationalCode, isCompany: false },
  };
  const results = await Promise.all(selectedChecks.map(async (check) => {
    if (retained[check]) return { check, result: retained[check]!, body: {} };
    try {
      const body = await call(check, payloads[check]);
      const nested = asRecord(body.data ?? body.result);
      // Providers use both a top-level result envelope and a nested envelope.
      // Do not discard the top-level success flag when data is a boolean.
      const item = ["success", "isSuccess", "valid", "status", "result", "code"]
        .some((key) => Object.hasOwn(nested, key)) ? nested : body;
      const providerData = item.data;
      const ok = success(item) &&
        (check === "shahkarLite" || check === "sana" ? providerData === true : true);
      return {
        check,
        result: {
          ok,
          completed: success(item),
          providerStatus: String(item.message ?? item.status ?? item.code ?? body.status ?? body.code ?? ""),
        },
        body,
      };
    } catch (error) {
      return {
        check,
        result: {
          ok: false,
          completed: false,
          providerStatus: error instanceof Error ? error.message : "provider_error",
        },
        body: {},
      };
    }
  }));
  const checkResults = Object.fromEntries(
    checks.map(check => [check, results.find(item => item.check === check)?.result ?? { ok: false, providerStatus: "not_requested" }]),
  ) as SapiVerificationResult["checks"];
  const canonical: Record<string, string> = {};
  const successfulBodies = results.filter(({ result }) => result.ok).map(({ body }) => body);
  const firstName = successfulBodies.map((body) => findString(body, ["firstName", "first_name"])).find(Boolean);
  const lastName = successfulBodies.map((body) => findString(body, ["lastName", "last_name", "family"])).find(Boolean);
  const fullName = successfulBodies.map((body) => findString(body, ["fullName", "full_name", "name"])).find(Boolean);
  if (firstName) canonical.officialFirstName = firstName;
  if (lastName) canonical.officialLastName = lastName;
  if ((!firstName || !lastName) && fullName) {
    const parts = fullName.split(/\s+/).filter(Boolean);
    if (!firstName && parts.length) canonical.officialFirstName = parts[0];
    if (!lastName && parts.length > 1) canonical.officialLastName = parts.slice(1).join(" ");
  }
  const fatherName = successfulBodies.map((body) => findString(body, ["fatherName", "father_name"])).find(Boolean);
  const address = successfulBodies.map((body) => findString(body, ["address", "fullAddress", "full_address"])).find(Boolean);
  const postalCode = successfulBodies.map((body) => findString(body, ["postalCode", "postal_code", "zipCode", "zip_code"])).find(Boolean);
  if (fatherName) canonical.officialFatherName = fatherName;
  if (address) canonical.officialAddress = address;
  if (postalCode) canonical.officialPostalCode = postalCode;
  else if (checkResults.postalCodeInfo.ok && input.postalCode) {
    canonical.officialPostalCode = input.postalCode;
  }
  const failed = selectedChecks.filter((check) => !checkResults[check].ok);
  return {
    status: failed.length ? "failed" : "verified",
    checks: checkResults,
    canonical,
    error: failed.length ? `SAPI checks failed: ${failed.join(", ")}` : undefined,
  };
}