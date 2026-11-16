/**
 * Background signature-refresh helpers.
 * Skip/backoff state lives in memory only — never writes generated documents,
 * contracts, templates, or those rows. Case 98 and generation 263 are never touched.
 */

export const PROTECTED_APPLICATION_IDS = new Set<number>([98]);
export const PROTECTED_GENERATION_IDS = new Set<number>([263]);

export type SignatureRefreshTarget = {
  applicationId: number;
  documentId: number;
  generationId?: number | null;
};

type SkipEntry = { until: number; hits: number; reason: string };

const skip = new Map<string, SkipEntry>();

export function signatureRefreshSkipKey(applicationId: number, documentId: number): string {
  return `${applicationId}:${documentId}`;
}

export function isProtectedSignatureTarget(t: SignatureRefreshTarget): boolean {
  if (PROTECTED_APPLICATION_IDS.has(Number(t.applicationId))) return true;
  if (t.generationId != null && PROTECTED_GENERATION_IDS.has(Number(t.generationId))) return true;
  return false;
}

export function rememberSignatureRefreshMiss(
  t: SignatureRefreshTarget,
  reason: string,
  now = Date.now(),
): SkipEntry {
  const key = signatureRefreshSkipKey(t.applicationId, t.documentId);
  const prev = skip.get(key);
  const hits = (prev?.hits ?? 0) + 1;
  const backoffMs = Math.min(6 * 60 * 60_000, 15 * 60_000 * 2 ** Math.min(hits - 1, 6));
  const entry = { until: now + backoffMs, hits, reason };
  skip.set(key, entry);
  return entry;
}

export function shouldSkipSignatureRefresh(t: SignatureRefreshTarget, now = Date.now()): boolean {
  if (isProtectedSignatureTarget(t)) return true;
  const entry = skip.get(signatureRefreshSkipKey(t.applicationId, t.documentId));
  return Boolean(entry && now < entry.until);
}

export function signatureRefreshSkipSize(): number {
  return skip.size;
}

export function resetSignatureRefreshSkipForTests(): void {
  skip.clear();
}

export const SIGNATURE_REFRESH_BATCH = 2;

export async function runSignatureRefreshQueue<T extends SignatureRefreshTarget>(
  items: T[],
  refresh: (t: T) => Promise<void>,
  opts: {
    now?: number;
    yieldFn?: () => Promise<void>;
    onSkip?: (t: T, why: "protected" | "backoff") => void;
    onMiss?: (t: T, reason: string, entry: SkipEntry) => void;
    onOtherError?: (t: T, err: unknown) => void;
    batch?: number;
  } = {},
): Promise<{ attempted: number; skipped: number; missed: number; otherErrors: number }> {
  const now = opts.now ?? Date.now();
  const yieldFn = opts.yieldFn ?? (() => new Promise<void>((r) => setImmediate(r)));
  const batch = opts.batch ?? SIGNATURE_REFRESH_BATCH;
  let attempted = 0, skipped = 0, missed = 0, otherErrors = 0, sinceYield = 0;
  for (const item of items) {
    if (shouldSkipSignatureRefresh(item, now)) {
      skipped++;
      opts.onSkip?.(item, isProtectedSignatureTarget(item) ? "protected" : "backoff");
      continue;
    }
    attempted++;
    try {
      await refresh(item);
    } catch (err) {
      const reason = err instanceof Error ? err.message : "error";
      if (reason === "generated_document_not_found") {
        const entry = rememberSignatureRefreshMiss(item, reason, now);
        missed++;
        opts.onMiss?.(item, reason, entry);
      } else {
        otherErrors++;
        opts.onOtherError?.(item, err);
      }
    }
    sinceYield++;
    if (sinceYield >= batch) {
      sinceYield = 0;
      await yieldFn();
    }
  }
  return { attempted, skipped, missed, otherErrors };
}
