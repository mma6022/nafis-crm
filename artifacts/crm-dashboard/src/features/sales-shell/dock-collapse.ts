/** today-layout v1.3: manual dock collapse (t303u) and auto-hide on scroll (t1031u). Client-only. */
import { useCallback, useEffect, useRef, useState } from "react";

const keyOf = (userId: number | undefined) => `nf-dock-hide:${userId ?? 0}`;

function readStored(userId: number | undefined): boolean {
  if (typeof window === "undefined" || userId == null) return false;
  try { return window.localStorage.getItem(keyOf(userId)) === "1"; } catch { return false; }
}

function writeStored(userId: number | undefined, hide: boolean) {
  if (typeof window === "undefined" || userId == null) return;
  try { window.localStorage.setItem(keyOf(userId), hide ? "1" : "0"); } catch { /* quota */ }
}

function scrollRoot(): { y: number; max: number } {
  const main = document.querySelector<HTMLElement>(".app-main");
  const se = document.scrollingElement || document.documentElement;
  const mainScrolls = Boolean(main && main.scrollHeight > main.clientHeight + 4 && getComputedStyle(main).overflowY !== "visible");
  if (mainScrolls && main) return { y: main.scrollTop, max: main.scrollHeight - main.clientHeight };
  const y = window.scrollY || se.scrollTop || 0;
  const max = Math.max(0, (se.scrollHeight || 0) - window.innerHeight);
  return { y, max };
}

export function useDockCollapse(userId: number | undefined, enabled = true) {
  const [collapsed, setCollapsed] = useState(() => enabled && readStored(userId));
  const [autoHide, setAutoHide] = useState(false);
  const lastY = useRef(0);
  const accDown = useRef(0);
  const accUp = useRef(0);
  const collapsedRef = useRef(collapsed);
  collapsedRef.current = collapsed;

  useEffect(() => {
    if (!enabled) return;
    setCollapsed(readStored(userId));
  }, [userId, enabled]);

  const applyBody = useCallback((hide: boolean, auto: boolean) => {
    document.body.classList.toggle("dock-collapsed", hide);
    document.body.classList.toggle("dock-autohide", !hide && auto);
  }, []);

  useEffect(() => {
    if (!enabled) {
      document.body.classList.remove("dock-collapsed", "dock-autohide");
      return;
    }
    applyBody(collapsed, autoHide);
    return () => document.body.classList.remove("dock-collapsed", "dock-autohide");
  }, [collapsed, autoHide, enabled, applyBody]);

  const collapse = useCallback(() => {
    setCollapsed(true);
    setAutoHide(false);
    writeStored(userId, true);
    window.setTimeout(() => document.querySelector<HTMLElement>(".dk-reopen")?.focus(), 0);
  }, [userId]);

  const expand = useCallback(() => {
    setCollapsed(false);
    setAutoHide(false);
    writeStored(userId, false);
    window.setTimeout(() => document.querySelector<HTMLElement>(".dk-toggle")?.focus(), 0);
  }, [userId]);

  const toggle = useCallback(() => {
    if (collapsedRef.current) expand(); else collapse();
  }, [collapse, expand]);

  useEffect(() => {
    if (!enabled) return;
    const { y } = scrollRoot();
    lastY.current = y;
    const onScroll = () => {
      if (collapsedRef.current) return;
      const mobile = window.matchMedia("(max-width:1023.98px)").matches;
      const typing = mobile && Boolean(document.activeElement && ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName));
      if (typing) { setAutoHide(true); return; }
      const { y, max } = scrollRoot();
      const dy = y - lastY.current;
      lastY.current = y;
      if (y <= 1 || max - y <= 24) { accDown.current = 0; accUp.current = 0; setAutoHide(false); return; }
      if (Math.abs(dy) < 8) return;
      if (dy > 0) {
        accUp.current = 0;
        accDown.current += dy;
        if (accDown.current > 48) setAutoHide(true);
      } else {
        accDown.current = 0;
        accUp.current += -dy;
        if (accUp.current >= 24) setAutoHide(false);
      }
    };
    const onFocusIn = (e: FocusEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && t.closest(".ss-dock, .ss-tb, .dock, .tb, .dk-toggle")) setAutoHide(false);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    document.querySelector(".app-main")?.addEventListener("scroll", onScroll, { passive: true });
    document.addEventListener("focusin", onFocusIn);
    return () => {
      window.removeEventListener("scroll", onScroll);
      document.querySelector(".app-main")?.removeEventListener("scroll", onScroll);
      document.removeEventListener("focusin", onFocusIn);
    };
  }, [enabled]);

  return { collapsed, autoHide, collapse, expand, toggle };
}
