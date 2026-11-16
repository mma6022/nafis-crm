import { useEffect, useState } from "react";
import { useLocation, useSearch } from "wouter";
import { useGetCustomer, getGetCustomerQueryKey, useGetLoanApplication, getGetLoanApplicationQueryKey } from "@workspace/api-client-react";
import { CreateReminderForm } from "@/components/Forms";
import { useMultiCaseCustomer, useMultiCaseStatus } from "@/lib/multi-case";
import { CaseContextPicker, isSampleCustomer, type CaseChoice } from "./CaseContextPicker";

/** SALES-FIXES 480000 (t810u bug 3): «ثبت یادآور» from anywhere. Pages can open it for a customer / case with this event. */
export const SF_REMINDER_EV = "sf480:reminder-open";
export const openReminderFor = (customerId: number, applicationId?: number | null) =>
  window.dispatchEvent(new CustomEvent(SF_REMINDER_EV, { detail: { customerId, applicationId: applicationId ?? null } }));

/** Header bell. A customer with two or more open cases must pick a case (general starts selected) before the reminder form.
 *  SALES-FIXES 480000: the bell binds the page's customer not only on /customers/:id but also on «کارهای امروز من» (/today?customer=)
 *  and on a case page (/loan-applications/:id → that case's customer, case-scoped). Before, those pages opened the form «بدون اتصال به مشتری»
 *  and its customer search (GET /customers) was 403 for a locked expert, so the reminder could not be attached to the customer. */
export function useHeaderReminder() {
  const [location] = useLocation();
  const search = useSearch();
  const caseId = Number((location.match(/^\/loan-applications\/(\d+)(?:\/|$)/) || [])[1] || 0);
  const la = useGetLoanApplication(caseId, { query: { enabled: caseId > 0, retry: false, queryKey: getGetLoanApplicationQueryKey(caseId) } });
  const todayCustomer = /^\/today(?:\/|$)/.test(location) ? Number(new URLSearchParams(search).get("customer") || 0) : 0;
  const pageCustomerId = Number((location.match(/^\/customers\/(\d+)/) || [])[1] || 0) || todayCustomer
    || (caseId > 0 ? Number((la.data as { customerId?: number } | undefined)?.customerId || 0) : 0);
  const [evTarget, setEvTarget] = useState<{ customerId: number; applicationId: number | null } | null>(null);
  const routeCustomerId = evTarget?.customerId || pageCustomerId;
  const caseFromPage = evTarget ? evTarget.applicationId : caseId > 0 && pageCustomerId > 0 ? caseId : null;
  const mc = useMultiCaseStatus();
  const enabled = mc.data?.enabled === true && routeCustomerId > 0;
  const ctx = useMultiCaseCustomer(routeCustomerId, enabled);
  const customer = useGetCustomer(routeCustomerId, { query: { enabled: routeCustomerId > 0, retry: false, queryKey: getGetCustomerQueryKey(routeCustomerId) } });
  const [pick, setPick] = useState(false);
  const [form, setForm] = useState(false);
  const [choice, setChoice] = useState<CaseChoice>("general");
  const openCases = (ctx.data?.cases ?? []).filter((row) => row.open);

  const open = () => {
    // on a case page the reminder belongs to that case (no picker)
    if (caseFromPage) { setChoice(caseFromPage); setForm(true); return; }
    if (enabled && openCases.length >= 2) { setChoice("general"); setPick(true); return; }
    setForm(true);
  };
  const [pendingOpen, setPendingOpen] = useState(0);
  useEffect(() => {
    const on = (e: Event) => { const d = (e as CustomEvent).detail as { customerId?: number; applicationId?: number | null } | undefined;
      if (!d?.customerId) return; setEvTarget({ customerId: Number(d.customerId), applicationId: d.applicationId ? Number(d.applicationId) : null }); setPendingOpen((x) => x + 1); };
    window.addEventListener(SF_REMINDER_EV, on); return () => window.removeEventListener(SF_REMINDER_EV, on);
  }, []);
  // the event's customer: wait for its open-cases answer, then open like the bell does
  useEffect(() => { if (!pendingOpen || (enabled && ctx.isLoading)) return; setPendingOpen(0); open(); }, [pendingOpen, enabled, ctx.isLoading]); // eslint-disable-line react-hooks/exhaustive-deps
  const close = () => { setForm(false); setChoice("general"); setEvTarget(null); };
  const name = customer.data?.name || "مشتری";
  const node = <>
    {pick ? <CaseContextPicker mode="reminder" customerName={name} customerId={routeCustomerId} phone={customer.data?.phone} sample={customer.data ? isSampleCustomer(customer.data) : false} cases={openCases} onClose={() => { setPick(false); setEvTarget(null); }} onConfirm={(next) => { setChoice(next); setPick(false); setForm(true); }} /> : null}
    {form ? <CreateReminderForm initialCustomerId={routeCustomerId || undefined} initialCustomerName={customer.data?.name} lockedApplicationId={typeof choice === "number" ? choice : null} caseScope={choice === "general" && routeCustomerId > 0 && enabled ? "general" : undefined} onClose={close} /> : null}
  </>;
  return { open, node };
}
