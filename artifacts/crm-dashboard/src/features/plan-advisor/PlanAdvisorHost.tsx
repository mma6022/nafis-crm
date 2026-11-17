/** Host: provider + sheet, only mounts the sheet when flag.plan_advisor_v1 is ON. */
import type { ReactNode } from "react";
import { usePaOn } from "./api";
import { PlanAdvisorProvider } from "./PlanAdvisorContext";
import { PlanAdvisorSheet } from "./PlanAdvisorSheet";

export function PlanAdvisorHost({ children }: { children: ReactNode }) {
  const on = usePaOn();
  return (
    <PlanAdvisorProvider>
      {children}
      {on ? <PlanAdvisorSheet /> : null}
    </PlanAdvisorProvider>
  );
}
