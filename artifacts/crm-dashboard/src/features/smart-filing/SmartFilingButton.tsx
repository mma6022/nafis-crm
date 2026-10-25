import { useState } from 'react';
import { Link, useLocation } from 'wouter';
import { Bot } from 'lucide-react';
import { useSfEligibility, sfFetch } from './api';

/** Case page action: «ثبت هوشمند با سارینا» — enabled only when the case's plan is linked to the ازکی‌وام panel. */
export function SmartFilingButton({ applicationId }: { applicationId: number }) {
  const q = useSfEligibility(applicationId);
  const [, navigate] = useLocation();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (!q.data) return null;
  const d = q.data;
  const openJob = d.latestJob && ['queued', 'running', 'waiting_human', 'ready_for_approval'].includes(d.latestJob.status) ? d.latestJob : null;
  if (!d.canCreate) return d.latestJob ? <Link className="csx-ghost" href={`/smart-filing/jobs/${d.latestJob.id}`}><Bot size={16} /> ثبت هوشمند ({d.latestJob.statusLabel})</Link> : null;
  const create = async () => {
    setBusy(true); setErr(null);
    try { const r = await sfFetch<{ id: number }>('/jobs', { method: 'POST', body: { applicationId } }); navigate(`/smart-filing/jobs/${r.id}`); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  if (openJob) return <Link className="csx-ghost" href={`/smart-filing/jobs/${openJob.id}`} data-testid="sf-open-job"><Bot size={16} /> ثبت هوشمند ({openJob.statusLabel})</Link>;
  return (
    <>
      <button type="button" className="csx-ghost" disabled={!d.eligible || busy} title={d.reason ?? undefined} onClick={() => void create()} data-testid="sf-create-job"><Bot size={16} /> ثبت هوشمند با سارینا</button>
      {err ? <span className="ldx-sub" role="alert" style={{ color: 'var(--nf-danger)' }}>{err}</span> : null}
    </>
  );
}
