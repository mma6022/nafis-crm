/**
 * Send a locked expert to /today only when they navigate to a route that is
 * not allowed (EL_ALLOWED_PAGES / server allowedPages, plus customer and
 * profile pages already permitted by elPageAllowed). A background API 403
 * must never bounce the shell — that was the 290000 menu bug.
 */
import { useEffect } from "react";
import { useLocation } from "wouter";
import { EL_LOCKDOWN_HOME } from "./guard";
import { elPageAllowed, useLockdownMe } from "./api";

export function LockdownRedirect() {
  const [location, setLocation] = useLocation();
  const elMe = useLockdownMe(true).data;
  const locked = elMe?.locked === true;

  useEffect(() => {
    if (!locked) return;
    const path = (location || "/").split("?")[0];
    if (path === EL_LOCKDOWN_HOME) return;
    if (elPageAllowed(elMe, location) || elPageAllowed(elMe, path)) return;
    setLocation(EL_LOCKDOWN_HOME);
  }, [locked, location, setLocation, elMe]);

  return null;
}
