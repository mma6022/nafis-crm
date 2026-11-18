/** «فضای کار بله» v1.0 (flag.bale_workspace_v1): the Bale inbox tells the live dock it is open, so the 390 dock can mark where the user is.
 *  Set only while the workspace is ON and the inbox is mounted; OFF → never set → the dock is exactly as live. */
import { useSyncExternalStore } from 'react';
let on = false; const subs = new Set<() => void>();
export function setBwsDockHint(v: boolean) { if (on === v) return; on = v; subs.forEach((f) => f()); }
export function useBwsDockHint() { return useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f); }; }, () => on, () => false); }
