// Client-side draft of the «درخواست تسهیلات» wizard, per signed-in user and customer.
// Stored only in this browser's localStorage (no backend change); expires after 7 days.
// It never contains documents, payments, OTPs or credit results — only where the user was and the chosen terms.
export type LoanDraft = {
  v: 2;
  customerId: number;
  customerName: string;
  /** Display step of the 10-step wizard (1..10). */
  step: number;
  planId: number | null;
  planName: string | null;
  amount: string;
  duration: string;
  updatedAt: string;
};

const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PREFIX = 'nafis.loanDraft.';
const key = (userId: number, customerId: number) => `${PREFIX}${userId}.${customerId}`;
// v1 drafts stored the internal 6-step index; map it onto the 10 display steps.
const V1_STEP_TO_DISPLAY = [1, 2, 5, 7, 8, 10];

function parseDraft(raw: string | null, customerId?: number): LoanDraft | null {
  if (!raw) return null;
  const draft = JSON.parse(raw) as Omit<LoanDraft, 'v'> & { v: number };
  if (draft?.v !== 1 && draft?.v !== 2) return null;
  if (customerId !== undefined && draft.customerId !== customerId) return null;
  const step = draft.v === 1 ? V1_STEP_TO_DISPLAY[Math.min(Math.max(Number(draft.step) || 1, 1), 6) - 1] : Math.min(Math.max(Number(draft.step) || 1, 1), 10);
  return { ...draft, v: 2, step };
}

export function readLoanDraft(userId: number | undefined | null, customerId: number): LoanDraft | null {
  if (!userId || !Number.isSafeInteger(customerId)) return null;
  try {
    const draft = parseDraft(window.localStorage.getItem(key(userId, customerId)), customerId);
    if (!draft) return null;
    if (Date.now() - new Date(draft.updatedAt).getTime() > TTL_MS) { window.localStorage.removeItem(key(userId, customerId)); return null; }
    return draft;
  } catch { return null; }
}

/** All unexpired drafts of this user on this device, newest first. */
export function listLoanDrafts(userId: number | undefined | null): LoanDraft[] {
  if (!userId) return [];
  const drafts: LoanDraft[] = [];
  try {
    const prefix = `${PREFIX}${userId}.`;
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const name = window.localStorage.key(i);
      if (!name?.startsWith(prefix)) continue;
      const customerId = Number(name.slice(prefix.length));
      const draft = Number.isSafeInteger(customerId) ? readLoanDraft(userId, customerId) : null;
      if (draft) drafts.push(draft);
    }
  } catch { /* storage disabled */ }
  return drafts.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function writeLoanDraft(userId: number | undefined | null, draft: Omit<LoanDraft, 'v' | 'updatedAt'>) {
  if (!userId) return;
  try {
    window.localStorage.setItem(key(userId, draft.customerId), JSON.stringify({ ...draft, v: 2, updatedAt: new Date().toISOString() }));
    window.dispatchEvent(new Event('nafis-loan-draft'));
  } catch { /* storage full or disabled: drafts are best-effort */ }
}

export function clearLoanDraft(userId: number | undefined | null, customerId: number) {
  if (!userId) return;
  try { window.localStorage.removeItem(key(userId, customerId)); window.dispatchEvent(new Event('nafis-loan-draft')); } catch { /* ignore */ }
}

/** Wizard entry for one customer. `from: 'customer'` returns to the customer page when the wizard closes. */
export function loanWizardHref(customerId: number, resume = false, from: 'customer' | 'list' = 'customer') {
  return `/loan-applications?new=1&customerId=${customerId}${from === 'customer' ? '&from=customer' : ''}${resume ? '&draft=1' : ''}`;
}
