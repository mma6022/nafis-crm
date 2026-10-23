type ProviderContractState = {
  status: string | null;
  title: string | null;
  signed: boolean;
};

export type ProviderStateClassification = "negative" | "pending" | "signed" | "unknown";
const normalizeState = (value: unknown) => String(value ?? "").toLowerCase().replace(/[\s_\-\u200c]+/g, "");
const negativeStates = [
  "unsigned", "notsigned", "notcompleted", "notcomplete", "uncompleted", "uncomplete", "incomplete",
  "unaccepted", "notaccepted", "notaccept", "notfinished", "unfinished", "notdone",
  "notyetsigned", "notsignedyet",
  "reject", "rejected", "declined", "cancelled", "canceled", "expired", "voided", "failed", "failure",
  "ردشده", "لغوشده", "منقضی", "امضانشده", "تکمیل‌نشده",
];
const pendingStates = ["pending", "waiting", "readyforsign", "readytobesigned", "درانتظار"];
const positiveStates = new Set([
  "accept", "accepted", "signed", "completed", "complete", "finished", "done",
  "امضاشده", "تکمیلشده", "پذیرفتهشده",
].map(normalizeState));

export function classifyProviderState(...values: unknown[]): ProviderStateClassification {
  const normalizedValues = values
    .filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
    .map(normalizeState);
  if (!normalizedValues.length) return "unknown";
  if (normalizedValues.some((value) => negativeStates.some((state) => value.includes(normalizeState(state))))) return "negative";
  if (normalizedValues.some((value) => pendingStates.some((state) => value.includes(normalizeState(state))))) return "pending";
  if (normalizedValues.some((value) => positiveStates.has(value))) return "signed";
  return "unknown";
}

export function isStrictSignedProviderState(...values: unknown[]): boolean {
  return classifyProviderState(...values) === "signed";
}

export function providerContractState(body: unknown): ProviderContractState {
  const root = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const objects = [
    root,
    root.data,
    root.result,
    root.contract,
    (root.data as Record<string, unknown> | undefined)?.contract,
    (root.result as Record<string, unknown> | undefined)?.contract,
  ].filter((value): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value)));
  const firstString = (names: string[]) => {
    for (const object of objects) for (const name of names) {
      const value = object[name];
      if (typeof value === "string" && value.trim()) return value.trim().slice(0, 120);
    }
    return null;
  };
  const status = firstString(["status", "contractStatus", "state"]);
  const title = firstString(["statusTitle", "statusText", "statusLabel", "statusFa"]);
  const classification = classifyProviderState(status, title);
  return { status, title, signed: classification === "signed" };
}