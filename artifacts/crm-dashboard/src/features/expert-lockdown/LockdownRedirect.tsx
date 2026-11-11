/**
 * If any query (or mutation) fails with 403 expert_lockdown, stop retrying and
 * send the locked expert to /today immediately so the page loader never sits
 * for 15s and then shows «اتصال اینترنت».
 */
import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { EL_LOCKDOWN_HOME, isExpertLockdownError } from "./guard";

export function LockdownRedirect() {
  const qc = useQueryClient();
  const [location, setLocation] = useLocation();

  useEffect(() => {
    const go = (error: unknown) => {
      if (!isExpertLockdownError(error)) return;
      if (location !== EL_LOCKDOWN_HOME) setLocation(EL_LOCKDOWN_HOME);
    };
    const uq = qc.getQueryCache().subscribe((ev) => {
      const err = ev?.query?.state?.error;
      if (err) go(err);
    });
    const um = qc.getMutationCache().subscribe((ev) => {
      const err = ev?.mutation?.state?.error;
      if (err) go(err);
    });
    return () => {
      uq();
      um();
    };
  }, [qc, location, setLocation]);

  return null;
}
