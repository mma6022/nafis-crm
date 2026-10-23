// Client-side draft of the «درخواست تسهیلات» wizard, per signed-in user and customer.
// Stored only in this browser's localStorage (no backend change); expires after 7 days.
// It never contains documents, payments or credit results — only where the user was and the chosen terms.
export type LoanDraft = {
  v: 1;
  customerId: number;
  customerName: string;
  step: number;
  planId: number | null;
  planName: string | null;
  amount: string;
  duration: string;
  updatedAt: string;
};

const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const key = (userId: number, customerId: number) => `nafis.loanDraft.${userId}.${customerId}`;

export function readLoanDraft(userId: number | undefined | null, customerId: number): LoanDraft | null {
  if (!userId || !Number.isSafeInteger(customerId)) return null;
  try {
    const raw = window.localStorage.getItem(key(userId, customerId));
    if (!raw) return null;
    const draft = JSON.parse(raw) as LoanDraft;
    if (draft?.v !== 1 || draft.customerId !== customerId) return null;
    if (Date.now() - new Date(draft.updatedAt).getTime() > TTL_MS) { window.localStorage.removeItem(key(userId, customerId)); return null; }
    return draft;
  } catch { return null; }
}

export function writeLoanDraft(userId: number | undefined | null, draft: Omit<LoanDraft, 'v' | 'updatedAt'>) {
  if (!userId) return;
  try {
    window.localStorage.setItem(key(userId, draft.customerId), JSON.stringify({ ...draft, v: 1, updatedAt: new Date().toISOString() }));
    window.dispatchEvent(new Event('nafis-loan-draft'));
  } catch { /* storage full or disabled: drafts are best-effort */ }
}

export function clearLoanDraft(userId: number | undefined | null, customerId: number) {
  if (!userId) return;
  try { window.localStorage.removeItem(key(userId, customerId)); window.dispatchEvent(new Event('nafis-loan-draft')); } catch { /* ignore */ }
}

export function loanWizardHref(customerId: number, resume = false) {
  return `/loan-applications?new=1&customerId=${customerId}&from=customer${resume ? '&draft=1' : ''}`;
}
