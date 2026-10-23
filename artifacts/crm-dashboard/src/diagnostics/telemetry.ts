import type { DiagnosticBrowserEvent } from '@workspace/api-client-react';

export const MAX_EVENTS = 30;
const EXCLUDED = /\/api\/(auth|diagnostics|public|wallet|wallets|customer-portal|portal)(\/|$|\?)/i;

export function redact(input: unknown, max = 1000): string {
  let s = typeof input === 'string' ? input : input instanceof Error ? input.message : '';
  s = s
    .replace(/((?:password|secret|token|api[_-]?key|authorization|cookie|رمز)\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]')
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '[redacted]')
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, '[redacted]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted]')
    .replace(/(?:\+|00)?[0-9\u06F0-\u06F9\u0660-\u0669][0-9\u06F0-\u06F9\u0660-\u0669\s().-]{7,}[0-9\u06F0-\u06F9\u0660-\u0669]/g, '[redacted]')
    .replace(/[A-Za-z0-9_-]{24,}/g, '[redacted]')
    .replace(/https?:\/\/[^\s"']+/g, (u) => stripUrl(u) ?? '[url]');
  return s.slice(0, max);
}

/** Returns path only (no query/hash). Null if cross-origin. */
export function stripUrl(raw: string, origin = typeof location !== 'undefined' ? location.origin : 'http://localhost'): string | null {
  try {
    const u = new URL(raw, origin);
    if (u.origin !== origin) return null;
    return redact(u.pathname, 500).replace(/\[redacted\]/g, ':id').slice(0, 500);
  } catch {
    return null;
  }
}

export function isExcludedPath(path: string): boolean {
  return EXCLUDED.test(path + '/');
}

export function stripPage(href: string): string {
  return (stripUrl(href) ?? '/').slice(0, 500) || '/';
}

export function createTelemetry() {
  let events: DiagnosticBrowserEvent[] = [];
  const push = (e: Omit<DiagnosticBrowserEvent, 'at'>) => {
    events.push({ ...e, at: new Date().toISOString().slice(0, 40) });
    if (events.length > MAX_EVENTS) events = events.slice(-MAX_EVENTS);
  };
  return {
    push,
    snapshot: () => events.slice(-MAX_EVENTS).map((e) => ({ ...e })),
    clear: () => { events = []; },
    install(win: Window & typeof globalThis = window): () => void {
      const onError = (ev: ErrorEvent) => {
        if (/^(?:chrome|moz|safari)-extension:\/\//.test(ev.filename ?? '')) return;
        push({ kind: 'error', message: redact(ev.message || 'error') });
      };
      const onRej = (ev: PromiseRejectionEvent) => {
        if (ev.reason instanceof Error && /(?:chrome|moz|safari)-extension:\/\//.test(ev.reason.stack ?? '')) return;
        push({ kind: 'rejection', message: redact(ev.reason instanceof Error ? ev.reason.message : typeof ev.reason === 'string' ? ev.reason : 'unhandled rejection') });
      };
      win.addEventListener('error', onError);
      win.addEventListener('unhandledrejection', onRej);
      const orig = win.fetch;
      const wrapped: typeof fetch = async (input, init) => {
        let method = 'GET';
        let path: string | null = null;
        try {
          const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
          method = (init?.method || (typeof input === 'object' && 'method' in input ? input.method : 'GET') || 'GET').toUpperCase();
          path = stripUrl(raw, win.location.origin);
          if (path && (!path.includes('/api/') || isExcludedPath(path))) path = null;
        } catch { path = null; }
        try {
          const res = await orig.call(win, input, init);
          if (path && !res.ok) {
            push({ kind: 'request', message: `${method} ${res.status}`, path, status: Math.min(599, res.status), requestId: (res.headers.get('X-CRM-Request-ID') || '').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 80) || undefined });
          }
          return res;
        } catch (err) {
          if (path && !(err instanceof DOMException && err.name === 'AbortError')) push({ kind: 'request', message: `${method} network failure`, path, status: 0 });
          throw err;
        }
      };
      win.fetch = wrapped;
      return () => {
        win.removeEventListener('error', onError);
        win.removeEventListener('unhandledrejection', onRej);
        if (win.fetch === wrapped) win.fetch = orig;
      };
    },
  };
}
export type Telemetry = ReturnType<typeof createTelemetry>;
