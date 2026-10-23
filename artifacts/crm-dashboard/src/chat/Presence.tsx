import { useEffect } from 'react';

/** Posts a heartbeat every 20s while the tab is visible. */
export function usePresence(post: () => Promise<unknown>, enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    const beat = () => { if (document.visibilityState === 'visible') post().catch(() => {}); };
    beat();
    const t = setInterval(beat, 20_000);
    document.addEventListener('visibilitychange', beat);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', beat); };
  }, [post, enabled]);
}
