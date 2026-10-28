// Navigation hints only: never proof of payment or permission to access an account.
const returnKey = 'customer-wallet-return';
type PaymentReturn = { customerId: number; path: string; at: number };
export function rememberPaymentReturn(customerId: number) {
  try {
    const path = window.location.pathname + window.location.search;
    if (!/^\/customer(?:\/|$|\?)/.test(path)) return;
    sessionStorage.setItem(returnKey, JSON.stringify({ customerId, path, at: Date.now() }));
  } catch { /* A blocked storage must not block payment. */ }
}
export function paymentReturnPath(): string | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(returnKey) || 'null') as PaymentReturn | null;
    if (!value || !Number.isSafeInteger(value.customerId) || value.customerId <= 0 ||
      !Number.isFinite(value.at) || Date.now() - value.at > 24 * 60 * 60 * 1000 || value.at > Date.now() ||
      typeof value.path !== 'string' || !/^\/customer(?:\/|$|\?)/.test(value.path) ||
      /[\\\u0000-\u001f\u007f]/.test(value.path)) return null;
    const url = new URL(value.path, window.location.origin);
    return url.origin === window.location.origin ? url.pathname + url.search : null;
  } catch { return null; }
}
// LEAKS-46: draft `amount` is the payout («مبلغ واریزی»); v2 key so a pre-release draft (principal) is never read as a payout.
const draftKey = (customerId: number, planId: number) => `customer-payment-draft-v2:${customerId}:${planId}`;
export function readPaymentDraft(customerId: number, planId: number): { amount: string; duration: string } {
  try {
    const saved = JSON.parse(sessionStorage.getItem(draftKey(customerId, planId)) || 'null');
    if (saved && Date.now() - saved.at < 24 * 60 * 60 * 1000 &&
      typeof saved.amount === 'string' && typeof saved.duration === 'string') return saved;
  } catch { /* No saved draft. */ }
  return { amount: '', duration: '' };
}
export function savePaymentDraft(customerId: number, planId: number, amount: string, duration: string) {
  try {
    sessionStorage.setItem(draftKey(customerId, planId), JSON.stringify({ amount, duration, at: Date.now() }));
  } catch { /* Keep the form usable without storage. */ }
}
