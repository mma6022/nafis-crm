import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Check, FileText, Image as ImageIcon, Trash2, Upload, Video } from 'lucide-react';
import { faDate, fileSize, messageError, shApi, shUpload, SH_MAX_BYTES, type ShDoc, type ShPlan } from './api';
import { Radio, Wizard } from './ui';

const TYPE_FA = { pdf: 'پی‌دی‌اف', video: 'ویدیو', image: 'تصویر' } as const;
const Ico = ({ t }: { t: ShDoc['fileType'] }) => <span className={`sh-fic ${t}`}>{t === 'pdf' ? <FileText aria-hidden="true" /> : t === 'video' ? <Video aria-hidden="true" /> : <ImageIcon aria-hidden="true" />}</span>;
export function DocsTab({ plans, toast }: { plans: ShPlan[]; toast: (t: string) => void }) {
  const [type, setType] = useState<'' | ShDoc['fileType']>(''); const [plan, setPlan] = useState('');
  const q = useQuery<{ docs: ShDoc[] }>({ queryKey: ['sh-docs', type, plan], queryFn: () => shApi(`/docs?${new URLSearchParams({ ...(type ? { type } : {}), ...(plan ? { plan } : {}) })}`), retry: false });
  const [add, setAdd] = useState(false); const [edit, setEdit] = useState<ShDoc | null>(null); const [err, setErr] = useState('');
  const del = async (d: ShDoc) => { setErr(''); try { await shApi(`/docs/${d.id}`, 'DELETE'); void q.refetch(); toast('فایل حذف شد.'); } catch (e) { setErr(messageError(e)); } };
  return <>
    <div className="sh-sech"><div><h2 className="sh-h2">آموزش‌ها و مستندات</h2><div className="sh-sub">پی‌دی‌اف، ویدیو و تصویر؛ اتصال به طرح اختیاری است</div></div>
      <button type="button" className="sh-btn pri sm" onClick={() => setAdd(true)} data-testid="sh-doc-add"><Upload aria-hidden="true" />بارگذاری فایل</button></div>
    <div className="sh-row sh-wrap" style={{ marginBottom: 16 }}>
      {(['', 'pdf', 'video', 'image'] as const).map((t) => <button type="button" key={t || 'all'} className={`sh-fchip${type === t ? ' on' : ''}`} onClick={() => setType(t)}>{t ? TYPE_FA[t] : 'همه'}</button>)}
      <span className="sh-sp" />
      <div className="sh-fld" style={{ width: 220 }}><select aria-label="طرح" value={plan} onChange={(e) => setPlan(e.target.value)}><option value="">همهٔ طرح‌ها</option><option value="none">بدون طرح</option>{plans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></div>
    </div>
    {err ? <p className="sh-err" role="alert">{err}</p> : null}
    {q.data && !q.data.docs.length ? <div className="sh-card sh-empty"><b>هنوز فایلی بارگذاری نشده.</b></div> : null}
    <div className="sh-grid sh-g3">{(q.data?.docs ?? []).map((d) => <article className="sh-card sh-ccard" key={d.id} data-testid="sh-doc-card">
      <div className="sh-row" style={{ alignItems: 'flex-start', gap: 12 }}><Ico t={d.fileType} /><div className="sh-sp"><h3 className="sh-h3">{d.title}</h3><div className="sh-sub">{TYPE_FA[d.fileType]}، {fileSize(d.sizeBytes)}، {faDate(d.createdAt)}</div></div></div>
      {d.description ? <p className="sh-sub" style={{ margin: 0 }}>{d.description}</p> : null}
      <div>{d.planName ? <span className="sh-chip tint">{d.planName}</span> : <span className="sh-chip">بدون طرح</span>}</div>
      <div className="sh-row"><button type="button" className="sh-btn sec sm sh-sp" onClick={() => setEdit(d)}>ویرایش</button><button type="button" className="sh-ib" aria-label={`حذف ${d.title}`} onClick={() => void del(d)}><Trash2 aria-hidden="true" /></button></div>
    </article>)}</div>
    {add || edit ? <DocWizard plans={plans} doc={edit} onClose={() => { setAdd(false); setEdit(null); }} onSaved={() => { setAdd(false); setEdit(null); void q.refetch(); toast('فایل ذخیره شد.'); }} /> : null}
  </>;
}
function DocWizard({ plans, doc, onClose, onSaved }: { plans: ShPlan[]; doc: ShDoc | null; onClose: () => void; onSaved: () => void }) {
  const [step, setStep] = useState(doc ? 1 : 0); const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState(doc?.title ?? ''); const [desc, setDesc] = useState(doc?.description ?? ''); const [plan, setPlan] = useState<number | null>(doc?.planId ?? null);
  const [err, setErr] = useState(''); const [busy, setBusy] = useState(false); const inp = useRef<HTMLInputElement>(null);
  const pick = (f: File | null | undefined) => { setErr(''); if (!f) return; if (f.size > SH_MAX_BYTES) { setErr('حجم فایل حداکثر ۲۰۰ مگابایت است.'); return; }
    if (!/^(application\/pdf|image\/|video\/)/.test(f.type) && !/\.(pdf|png|jpe?g|webp|mp4|mov|webm)$/i.test(f.name)) { setErr('فقط پی‌دی‌اف، ویدیو یا تصویر.'); return; }
    setFile(f); if (!title) setTitle(f.name.replace(/\.[^.]+$/, '')); };
  const save = async () => { setBusy(true); setErr('');
    try { if (doc) await shApi(`/docs/${doc.id}`, 'PATCH', { title, description: desc, planId: plan }); else if (file) await shUpload(file, { title, description: desc, planId: plan, fileName: file.name, mime: file.type }); onSaved(); }
    catch (e) { setErr(messageError(e)); } finally { setBusy(false); } };
  const steps = ['فایل', 'نام و توضیح', 'طرح'];
  const next = () => { if (step === 1 && !title.trim()) { setErr('نام فایل را بنویسید.'); return; } setErr(''); setStep(step + 1); };
  return <Wizard title={doc ? 'ویرایش فایل' : 'بارگذاری فایل'} steps={steps} cur={step} onClose={onClose} testId="sh-doc-wizard"
    foot={step === 2 ? <><button type="button" className="sh-btn pri" disabled={busy} onClick={() => void save()} data-testid="sh-doc-save">ذخیره</button><button type="button" className="sh-btn ghost" onClick={() => setStep(1)}>قبلی</button></>
      : <><button type="button" className="sh-btn pri" disabled={step === 0 && !file} onClick={next} data-testid="sh-doc-next">ادامه</button><button type="button" className="sh-btn ghost" onClick={() => (step === 0 || doc ? onClose() : setStep(step - 1))}>{step === 0 || (doc && step === 1) ? 'انصراف' : 'قبلی'}</button></>}>
    {step === 0 ? <div className="sh-drop" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); pick(e.dataTransfer.files?.[0]); }}>
      <Upload aria-hidden="true" /><b>فایل را اینجا بیندازید یا انتخاب کنید</b><span className="sh-sub">پی‌دی‌اف، ویدیو یا تصویر، حداکثر ۲۰۰ مگابایت</span>
      <input ref={inp} type="file" hidden accept="application/pdf,image/*,video/*" onChange={(e) => pick(e.target.files?.[0])} data-testid="sh-doc-file" />
      <button type="button" className="sh-btn sec sm" onClick={() => inp.current?.click()}>انتخاب فایل</button>
      {file ? <span className="sh-chip ok"><Check aria-hidden="true" />{file.name}، {fileSize(file.size)}</span> : null}
      {err ? <p className="sh-err" role="alert">{err}</p> : null}</div>
    : step === 1 ? <div className="sh-stack" style={{ gap: 14 }}>
      {file ? <div className="sh-row sh-card" style={{ padding: 12 }}><span className="sh-fic pdf"><FileText aria-hidden="true" /></span><div className="sh-sp"><b>{file.name}</b><div className="sh-sub">{fileSize(file.size)}</div></div><span className="sh-chip ok"><Check aria-hidden="true" />آمادهٔ بارگذاری</span></div> : null}
      <label className="sh-frow"><span className="sh-lbl">نام</span><div className={`sh-fld${err ? ' err' : ''}`}><input value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} data-testid="sh-doc-title" /></div>{err ? <p className="sh-err" role="alert">{err}</p> : null}</label>
      <label className="sh-frow"><span className="sh-lbl">توضیح</span><textarea className="sh-ta" style={{ minHeight: 96 }} value={desc} maxLength={400} onChange={(e) => setDesc(e.target.value)} /></label></div>
    : <div className="sh-stack" role="radiogroup" aria-label="اتصال به طرح (اختیاری)"><div className="sh-lbl">اتصال به طرح (اختیاری)</div>
      <Radio on={plan == null} title="بدون طرح" sub="فقط در فهرست آموزش‌ها" onClick={() => setPlan(null)} />
      {plans.map((p) => <Radio key={p.id} on={plan === p.id} title={p.name} sub={`در بله: ${p.publicLabel}`} onClick={() => setPlan(p.id)} />)}
      {err ? <p className="sh-err" role="alert">{err}</p> : null}</div>}
  </Wizard>;
}
