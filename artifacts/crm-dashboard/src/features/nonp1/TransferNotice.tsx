/**
 * crm-nonp1-to-kazemi: every API write that moved a customer to Kazemi (priority ≠ 1 on a closer's customer)
 * answers with the X-Nafis-Customer-Transferred header. One global listener turns it into the toast
 * «مشتری به آقای کاظمی منتقل شد» on every path (quick edit, customer page, customer form, board, call result, API),
 * refreshes the lists, and takes an expert off the page of a customer they no longer own.
 * No other notification: this toast is the only signal.
 */
import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useLocation } from 'wouter';
import './transfer-notice.css';

export const TRANSFER_HEADER = 'x-nafis-customer-transferred';
export const TRANSFER_EVENT = 'nafis:customer-transferred';
export const TRANSFER_TOAST = 'مشتری به آقای کاظمی منتقل شد';

declare global { interface Window { __nafisTransferFetch?: boolean } }

/** Wraps window.fetch once; only reads a response header, never touches the body. */
export function installTransferNotice(): void {
  if (typeof window === 'undefined' || window.__nafisTransferFetch) return;
  window.__nafisTransferFetch = true;
  const original = window.fetch.bind(window);
  window.fetch = async (...args: Parameters<typeof fetch>) => {
    const response = await original(...args);
    try {
      const id = response.headers.get(TRANSFER_HEADER);
      if (id && /^\d+$/.test(id)) window.dispatchEvent(new CustomEvent(TRANSFER_EVENT, { detail: { customerId: Number(id) } }));
    } catch { /* header read must never break a request */ }
    return response;
  };
}
installTransferNotice();

export function TransferNotice({ isAdmin }: { isAdmin: boolean }) {
  const [shown, setShown] = useState(0);
  const queryClient = useQueryClient();
  const [location, setLocation] = useLocation();
  useEffect(() => {
    const onTransfer = (e: Event) => {
      const customerId = (e as CustomEvent<{ customerId: number }>).detail?.customerId;
      setShown(Date.now());
      void queryClient.invalidateQueries();
      // The expert no longer owns this customer: leave its page instead of showing «not found».
      if (!isAdmin && customerId && new RegExp(`^/customers/${customerId}(?:[/?#]|$)`).test(location)) setLocation('/customers');
    };
    window.addEventListener(TRANSFER_EVENT, onTransfer);
    return () => window.removeEventListener(TRANSFER_EVENT, onTransfer);
  }, [isAdmin, location, queryClient, setLocation]);
  useEffect(() => {
    if (!shown) return;
    const t = window.setTimeout(() => setShown(0), 4000);
    return () => window.clearTimeout(t);
  }, [shown]);
  return shown ? <div className="nf-transfer-toast" role="status" aria-live="polite" data-testid="toast-nonp1-transfer">{TRANSFER_TOAST}</div> : null;
}
