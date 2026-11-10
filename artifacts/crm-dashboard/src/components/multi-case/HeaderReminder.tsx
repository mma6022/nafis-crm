import { useState } from "react";
import { useLocation } from "wouter";
import { useGetCustomer, getGetCustomerQueryKey } from "@workspace/api-client-react";
import { CreateReminderForm } from "@/components/Forms";
import { useMultiCaseCustomer, useMultiCaseStatus } from "@/lib/multi-case";
import { CaseContextPicker, isSampleCustomer, type CaseChoice } from "./CaseContextPicker";

/** Header bell. A customer with two or more open cases must pick a case (general starts selected) before the reminder form. */
export function useHeaderReminder() {
  const [location] = useLocation();
  const routeCustomerId = Number((location.match(/^\/customers\/(\d+)/) || [])[1] || 0);
  const mc = useMultiCaseStatus();
  const enabled = mc.data?.enabled === true && routeCustomerId > 0;
  const ctx = useMultiCaseCustomer(routeCustomerId, enabled);
  const customer = useGetCustomer(routeCustomerId, { query: { enabled, queryKey: getGetCustomerQueryKey(routeCustomerId) } });
  const [pick, setPick] = useState(false);
  const [form, setForm] = useState(false);
  const [choice, setChoice] = useState<CaseChoice>("general");
  const openCases = (ctx.data?.cases ?? []).filter((row) => row.open);

  const open = () => {
    if (enabled && openCases.length >= 2) { setChoice("general"); setPick(true); return; }
    setForm(true);
  };
  const name = customer.data?.name || "مشتری";
  const node = <>
    {pick ? <CaseContextPicker mode="reminder" customerName={name} customerId={routeCustomerId} phone={customer.data?.phone} sample={customer.data ? isSampleCustomer(customer.data) : false} cases={openCases} onClose={() => setPick(false)} onConfirm={(next) => { setChoice(next); setPick(false); setForm(true); }} /> : null}
    {form ? <CreateReminderForm initialCustomerId={routeCustomerId || undefined} lockedApplicationId={typeof choice === "number" ? choice : null} caseScope={choice === "general" && routeCustomerId > 0 && enabled ? "general" : undefined} onClose={() => { setForm(false); setChoice("general"); }} /> : null}
  </>;
  return { open, node };
}
