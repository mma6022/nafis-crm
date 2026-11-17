/** plan-advisor v1: open the dock sheet from the today box or the dock «دستیار» item. */
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { useLocation, useSearch } from "wouter";
import type { PaStep } from "./helpers";

export type PaOpenOpts = { customerId?: number | null; step?: PaStep; planId?: number | null };
type Ctx = {
  open: boolean;
  step: PaStep;
  customerId: number | null;
  planId: number | null;
  routeCustomerId: number | null;
  openSheet: (opts?: PaOpenOpts) => void;
  closeSheet: () => void;
  setStep: (s: PaStep) => void;
  setCustomerId: (id: number | null) => void;
  setPlanId: (id: number | null) => void;
};
const C = createContext<Ctx | null>(null);

function customerFromRoute(location: string, search: string): number | null {
  const q = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const fromQ = Number(q.get("customer") || q.get("customerId") || "");
  if (Number.isInteger(fromQ) && fromQ > 0) return fromQ;
  const m = /\/customers\/(\d+)(?:\/|$)/.exec(location);
  if (m) { const n = Number(m[1]); if (Number.isInteger(n) && n > 0) return n; }
  return null;
}

export function PlanAdvisorProvider({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const search = useSearch();
  const routeCustomerId = customerFromRoute(location, search);
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<PaStep>(1);
  const [customerId, setCustomerId] = useState<number | null>(null);
  const [planId, setPlanId] = useState<number | null>(null);
  const openSheet = useCallback((opts?: PaOpenOpts) => {
    const cid = opts?.customerId !== undefined ? opts.customerId : routeCustomerId;
    setCustomerId(cid ?? null);
    setPlanId(opts?.planId ?? null);
    if (opts?.step != null) setStep(opts.step);
    else if (opts?.planId) setStep(3);
    else if (cid) setStep(1);
    else setStep(0);
    setOpen(true);
  }, [routeCustomerId]);
  const closeSheet = useCallback(() => setOpen(false), []);
  const value = useMemo(() => ({ open, step, customerId, planId, routeCustomerId, openSheet, closeSheet, setStep, setCustomerId, setPlanId }),
    [open, step, customerId, planId, routeCustomerId, openSheet, closeSheet]);
  return <C.Provider value={value}>{children}</C.Provider>;
}

export function usePlanAdvisor(): Ctx {
  const v = useContext(C);
  if (!v) throw new Error("usePlanAdvisor outside provider");
  return v;
}
export function usePlanAdvisorOptional(): Ctx | null {
  return useContext(C);
}
