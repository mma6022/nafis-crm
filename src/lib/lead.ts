/**
 * Website lead → CRM POST /api/public/leads (contract: nafis-crm artifacts/api-server/src/lib/public-leads.ts,
 * branch feat/public-leads). Success is shown ONLY on a 2xx response; anything else is an error the UI must show.
 */
import { normalizeIranMobile } from './format';
import type { AmountBand } from './plans';

export type Need = 'cash' | 'goods' | 'help';
export type ContactTime = 'morning' | 'evening' | 'any';
export const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'] as const;
export type Utm = Partial<Record<(typeof UTM_KEYS)[number], string>>;

export interface LeadInput {
  name: string;
  phone: string;
  need: Need;
  amountBand: AmountBand | 'unsure';
  planId?: number | null;
  term?: number | null;
  contactTime: ContactTime;
  src?: string | null;
  consent: boolean;
  /** honeypot value (must stay "") */
  website: string;
  startedAt: number;
  utm?: Utm;
}

const SRC_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
export const cleanSrc = (v: string | null | undefined) => {
  const s = (v ?? '').toLowerCase().trim();
  return SRC_RE.test(s) ? s : undefined;
};

/** Exact CRM payload: only allowed keys, unknown keys would be rejected with 400. */
export function buildLeadPayload(i: LeadInput): Record<string, unknown> {
  const phone = normalizeIranMobile(i.phone);
  if (!phone) throw new LeadError('invalid_phone');
  const out: Record<string, unknown> = {
    name: i.name.trim().slice(0, 80),
    phone,
    need: i.need,
    amountBand: i.amountBand,
    contactTime: i.contactTime,
    consent: i.consent === true,
    website: i.website,
    startedAt: i.startedAt,
  };
  if (i.planId) out.planId = i.planId;
  if (i.planId && i.term) out.term = i.term;
  const src = cleanSrc(i.src);
  if (src) out.src = src;
  for (const k of UTM_KEYS) {
    const v = i.utm?.[k]?.trim();
    if (v) out[k] = v.slice(0, 100);
  }
  return out;
}

export class LeadError extends Error {
  code: string;
  status: number;
  constructor(code: string, status = 0) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

export const leadEndpoint = (): string | undefined =>
  (import.meta.env?.PUBLIC_LEAD_ENDPOINT as string | undefined)?.trim() || undefined;

export interface LeadResult {
  /** Present only when the CRM returned one (201 for a new lead); the UI hides the line otherwise. */
  trackingCode?: string;
}
/** Only a short reference shape is ever shown; anything else from the response is ignored. */
const TRACKING_RE = /^[A-Z0-9][A-Z0-9-]{3,23}$/;
export function readTrackingCode(body: unknown): string | undefined {
  const v = (body as { trackingCode?: unknown } | null)?.trackingCode;
  return typeof v === 'string' && TRACKING_RE.test(v.trim()) ? v.trim() : undefined;
}

/** Resolves only on 2xx. Missing endpoint, network failure and non-2xx all reject with LeadError. */
export async function submitLead(i: LeadInput, endpoint = leadEndpoint(), fetchImpl: typeof fetch = fetch): Promise<LeadResult> {
  if (!endpoint) throw new LeadError('no_endpoint');
  const body = JSON.stringify(buildLeadPayload(i));
  let res: Response;
  try {
    res = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body,
      credentials: 'omit',
      signal: AbortSignal.timeout?.(15000),
    });
  } catch {
    throw new LeadError('network');
  }
  if (res.status < 200 || res.status > 299) {
    let code = 'http';
    try {
      code = ((await res.json()) as { error?: string }).error ?? code;
    } catch {
      /* non-JSON error body */
    }
    throw new LeadError(code, res.status);
  }
  try {
    const code = readTrackingCode(await res.json());
    return code ? { trackingCode: code } : {};
  } catch {
    return {}; // 204 / empty or non-JSON success body
  }
}

/** UTM params from the landing URL, kept for the session (set in BaseLayout). */
export function readUtm(): Utm {
  try {
    return JSON.parse(sessionStorage.getItem('nf-utm') ?? '{}') as Utm;
  } catch {
    return {};
  }
}
