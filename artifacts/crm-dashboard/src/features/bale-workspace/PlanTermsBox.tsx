/* «فضای کار بله» و — «شرایط طرح در بله» inside each plan's edit view on «طرح‌های تسهیلاتی» (Armita 2026-11-18).
 * Own storage (bws plan terms, additive): saving here never touches loan_plans; it has its own button, separate from «ذخیره طرح».
 * Renders nothing while flag.bale_workspace_v1 is OFF or for anyone who is not sales manager / admin. */
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { bbFetch } from '@/features/bale-bot/api';
import { bwsErr, useBwsMe, type AdminState } from './api';
import './bale-workspace.css';

export function BwsPlanTermsBox({ planId, planName }: { planId: number; planName: string }) {
  const me = useBwsMe(); const on = !!me.data?.canManage;
  const qc = useQueryClient();
  const st = useQuery<AdminState>({ queryKey: ['bws-admin'], enabled: on, retry: false, queryFn: () => bbFetch('/bale-workspace/admin/state') });
  const saved = st.data?.plans.find((p) => p.id === planId)?.terms ?? null;
  const [text, setText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false); const [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null);
  useEffect(() => { setText(null); setMsg(null); }, [planId]);
  if (!on || !st.data || saved == null) return null;
  const val = text ?? saved;
  const save = async () => {
    setBusy(true); setMsg(null);
    try { const r = await bbFetch<AdminState>(`/bale-workspace/admin/plan-terms/${planId}`, { method: 'PUT', body: { body: val } }); qc.setQueryData(['bws-admin'], r); setText(null); setMsg({ ok: true, t: 'متن بله ذخیره شد.' }); }
    catch (e) { setMsg({ ok: false, t: bwsErr(e) }); } finally { setBusy(false); }
  };
  return <section className="bws-ptb" aria-labelledby={`bws-ptb-${planId}`} data-testid={`bws-plan-terms-${planId}`}>
    <h4 id={`bws-ptb-${planId}`}>شرایط طرح در بله</h4>
    <p className="bws-ptb-hint">متن آماده‌ای که کارشناس بعد از تماس از ابزار «شرایط طرح» در بله می‌فرستد. جدا از «ذخیره طرح» ذخیره می‌شود و خود طرح را عوض نمی‌کند.</p>
    <textarea className="bws-ptb-ta" rows={5} dir="rtl" aria-label={`شرایط ${planName} در بله`} value={val} maxLength={1500}
      onChange={(e) => setText(e.target.value)} placeholder="مثلاً: تا ۲۰۰ میلیون تومان، بازپرداخت ۲۴ ماهه، یک ضامن کارمند یا چک صیادی" data-testid="bws-plan-terms-text" />
    <div className="bws-ptb-row">
      {msg ? <span className={`bws-ptb-msg${msg.ok ? '' : ' err'}`} role="status">{msg.t}</span> : <span className="bws-ptb-msg">{saved ? 'برای کارشناس‌ها فعال است.' : 'هنوز متنی ثبت نشده؛ این طرح در ابزار «شرایط طرح» دیده نمی‌شود.'}</span>}
      <button type="button" className="btn btn-primary bws-ptb-save" disabled={busy || val === saved} onClick={() => void save()} data-testid="bws-plan-terms-save">{busy ? 'در حال ذخیره…' : 'ذخیرهٔ متن بله'}</button>
    </div>
  </section>;
}
