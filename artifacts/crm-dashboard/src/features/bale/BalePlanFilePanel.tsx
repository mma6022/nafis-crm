import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, FileText, Paperclip, Trash2, Upload } from 'lucide-react';
import { toast } from '@/hooks/use-toast';
import { BALE_PLAN_FILE_ACCEPT, baleFetch, balePlanFileHref, baleWhen, faSize, type BalePlanFiles } from './api';
import './bale.css';

/** «فایل طرح برای بله» (admin only; the server answers 403 to everyone else and this renders nothing).
 *  One file per plan: PDF / JPG / PNG / WebP up to 10MB. Upload works even while the Bale attachment switch is OFF. */
const KEY = ['bale', 'plan-files'] as const;
export function useBalePlanFiles() {
  return useQuery({ queryKey: KEY, queryFn: () => baleFetch<BalePlanFiles>('/admin/bale/plan-files'), retry: false, staleTime: 30_000 });
}

export function BalePlanFileBadge({ planId }: { planId: number }) {
  const q = useBalePlanFiles(); const f = q.data?.plans.find(p => p.planId === planId)?.file;
  return f ? <span className="inline-badge bl-plan-badge" title={`${f.name}، ${f.typeLabel}`} data-testid={`badge-bale-plan-file-${planId}`}><Paperclip size={12} /> فایل بله</span> : null;
}

export function BalePlanFileBox({ planId }: { planId: number }) {
  const qc = useQueryClient(); const q = useBalePlanFiles(); const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null); const [confirmDel, setConfirmDel] = useState(false);
  if (q.isError || !q.data) return null; // not an admin (or plan files unavailable)
  const p = q.data.plans.find(x => x.planId === planId); if (!p) return null;
  const f = p.file;
  const upload = async (file: File | undefined) => {
    if (!file) return; setErr(null);
    if (file.size > q.data.maxBytes) { setErr('حجم فایل بیشتر از ۱۰ مگابایت است.'); return; }
    setBusy(true);
    try {
      const fd = new FormData(); fd.append('file', file, file.name);
      const r = await fetch(balePlanFileHref(`/api/admin/bale/plans/${planId}/file`), { method: 'POST', credentials: 'include', body: fd });
      const j = await r.json().catch(() => ({})) as { message?: string };
      if (!r.ok) { setErr(j.message || 'بارگذاری انجام نشد. دوباره امتحان کنید.'); return; }
      toast({ title: f ? 'فایل طرح جایگزین شد' : 'فایل طرح بارگذاری شد' });
    } catch { setErr('اتصال برقرار نشد. دوباره امتحان کنید.'); }
    finally { setBusy(false); if (input.current) input.current.value = ''; void qc.invalidateQueries({ queryKey: KEY }); }
  };
  const remove = async () => {
    setBusy(true); setErr(null);
    try { await baleFetch(`/admin/bale/plans/${planId}/file`, { method: 'DELETE' }); toast({ title: 'فایل طرح حذف شد' }); setConfirmDel(false); }
    catch (e) { setErr(e instanceof Error ? e.message : 'حذف انجام نشد.'); } finally { setBusy(false); void qc.invalidateQueries({ queryKey: KEY }); }
  };
  const href = f ? balePlanFileHref(f.url) : null;
  return <section className="plan-detail-section bl-planfile" data-testid={`panel-bale-plan-file-${planId}`} aria-labelledby={`h-bale-pf-${planId}`}>
    <h4 id={`h-bale-pf-${planId}`}><Paperclip size={15} /> فایل طرح برای بله</h4>
    <p className="muted">دستیار فروش می‌تواند این فایل را برای مشتری پیشنهاد دهد؛ همیشه اول کارشناس تأیید می‌کند.
      {!q.data.attachmentsEnabled ? ' ارسال فایل در بله فعلاً خاموش است؛ بارگذاری ممکن است.' : ''}</p>
    {f ? <div className="bl-file">
      {f.isImage && href ? <a className="thumb" href={href} target="_blank" rel="noopener noreferrer" aria-label={`نمایش بزرگ ${f.name}`}><img src={href} alt={f.name} width={72} height={72} loading="lazy" /></a>
        : <span className="ico" aria-hidden="true"><FileText size={22} /></span>}
      <span className="inf"><b dir="auto">{f.name}</b>
        <span className="muted">{[f.typeLabel, faSize(f.size), `بارگذاری ${baleWhen(f.uploadedAt)}`, f.uploadedBy].filter(Boolean).join('، ')}</span>
        {href ? <a href={href} target="_blank" rel="noopener noreferrer">{f.isImage ? 'نمایش عکس' : 'باز کردن فایل'}</a> : null}</span>
    </div> : <p className="muted" data-testid={`text-bale-plan-file-none-${planId}`}>هنوز فایلی برای این طرح بارگذاری نشده است.</p>}
    <input ref={input} type="file" accept={BALE_PLAN_FILE_ACCEPT} hidden onChange={e => void upload(e.target.files?.[0])} data-testid={`input-bale-plan-file-${planId}`} aria-label="انتخاب فایل طرح" />
    <div className="bl-acts">
      <button type="button" className="btn btn-primary" disabled={busy} onClick={() => input.current?.click()} data-testid={`button-bale-plan-file-upload-${planId}`}>
        <Upload size={15} /> {busy ? 'لطفاً صبر کنید…' : f ? 'جایگزین کردن فایل' : 'بارگذاری فایل'}</button>
      {f ? confirmDel ? <>
        <button type="button" className="btn" style={{ color: '#B42318' }} disabled={busy} onClick={() => void remove()} data-testid={`button-bale-plan-file-delete-confirm-${planId}`}>بله، حذف کن</button>
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setConfirmDel(false)}>انصراف</button></>
        : <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setConfirmDel(true)} data-testid={`button-bale-plan-file-delete-${planId}`}><Trash2 size={15} /> حذف فایل</button> : null}
    </div>
    <span className="muted" style={{ fontSize: 12 }}>فقط PDF یا عکس JPG / PNG / WebP، حداکثر ۱۰ مگابایت.</span>
    {err ? <p className="bl-err" role="alert" data-testid={`text-bale-plan-file-error-${planId}`}><AlertCircle size={15} /> {err}</p> : null}
  </section>;
}
