import { useEffect, useRef, useState } from 'react';
import { Loader2, RefreshCw, X } from 'lucide-react';
import './team-sales.css';
import { useTeamSalesConfig, usesSimpleForm, type TeamSalesConfig } from './api';

type LaunchUser = { salespersonId?: number | null } | undefined;
type LaunchCustomer = { salespersonId?: number | null; status?: string | null; priority?: number | null };
export type CallFormKind = 'simple' | 'legacy';
export type CallChoice = CallFormKind | 'wait' | 'error';

/**
 * Pure decision used by every «ثبت تماس» entry point.
 * Until the team-sales settings are known we never fall back to the legacy form for a customer
 * that could be qualifier-owned (i.e. owned by this user's own salesperson): 'wait' while loading,
 * 'error' if loading failed. Anyone else's customer can't match the rule, so legacy is safe at once.
 */
export function chooseCallForm(
  cfg: TeamSalesConfig | undefined, cfgState: 'idle' | 'loading' | 'error' | 'ready',
  user: LaunchUser, customer: LaunchCustomer | null | undefined,
): CallChoice {
  if (!user || user.salespersonId == null || !customer) return 'legacy';
  if (cfgState === 'idle') return 'legacy';
  if (cfg && cfgState === 'ready') return usesSimpleForm(cfg, user, customer) ? 'simple' : 'legacy';
  if (customer.salespersonId !== user.salespersonId) return 'legacy';
  // The rule can never apply to prioritised (P1/P2/P3) or not-in-progress customers, whatever the settings say.
  if (customer.priority != null || (customer.status != null && customer.status !== 'in_progress')) return 'legacy';
  return cfgState === 'error' ? 'error' : 'wait';
}

export function useCallLauncher<C extends LaunchCustomer>(user: LaunchUser, enabled: boolean, open: (customer: C, kind: CallFormKind) => void) {
  const q = useTeamSalesConfig(enabled && !!user);
  const cfgState: 'idle' | 'loading' | 'error' | 'ready' = !enabled || !user ? 'idle' : q.data ? 'ready' : q.isError && !q.isFetching ? 'error' : 'loading';
  const [pending, setPending] = useState<C | null>(null);
  const openRef = useRef(open); openRef.current = open;
  const choose = (c: C | null | undefined) => chooseCallForm(q.data, cfgState, user, c);
  const launch = (c: C) => {
    const k = choose(c);
    if (k === 'simple' || k === 'legacy') { setPending(null); openRef.current(c, k); } else setPending(c);
  };
  useEffect(() => {
    if (!pending) return;
    const k = chooseCallForm(q.data, cfgState, user, pending);
    if (k === 'simple' || k === 'legacy') { setPending(null); openRef.current(pending, k); }
  }, [pending, q.data, cfgState, user]);
  const status: 'wait' | 'error' | null = pending ? (choose(pending) === 'error' ? 'error' : 'wait') : null;
  return {
    config: q.data, cfgState, choose, launch, pending, status,
    retry: () => { void q.refetch(); }, cancel: () => setPending(null),
  };
}

/** Small status card shown while a «ثبت تماس» click waits for the team-sales settings. */
export function CallLaunchStatus({ status, onRetry, onCancel }: { status: 'wait' | 'error' | null; onRetry: () => void; onCancel: () => void }) {
  if (!status) return null;
  return <div className={`ts-launch${status === 'error' ? ' bad' : ''}`} role={status === 'error' ? 'alert' : 'status'} aria-live="polite" data-testid="ts-launch-status" data-state={status}>
    {status === 'wait'
      ? <><Loader2 size={17} className="ts-spin" aria-hidden="true" /><span>در حال آماده‌سازی فرم تماس…</span></>
      : <><span>تنظیمات فرم تماس بارگذاری نشد.</span>
        <button type="button" className="ts-launch-btn" onClick={onRetry} data-testid="ts-launch-retry"><RefreshCw size={15} aria-hidden="true" /> تلاش دوباره</button></>}
    <button type="button" className="ts-launch-x" onClick={onCancel} aria-label="بستن" data-testid="ts-launch-cancel"><X size={16} /></button>
  </div>;
}
