import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { FileText, MessageCircle, Plus } from 'lucide-react';
import { fa, messageError, shApi, useShMe, type ShMessage, type ShPlan } from './api';
import { AfterConnect, CheckBox, Switch, Wizard } from './ui';

type Data = { free: ShMessage[]; plans: { plan: ShPlan; messages: ShMessage[] }[]; vars: string[] };
export function MessagesTab({ toast }: { toast: (t: string) => void }) {
  const q = useQuery<Data>({ queryKey: ['sh-messages'], queryFn: () => shApi('/messages'), retry: false });
  const [edit, setEdit] = useState<{ m?: ShMessage; planId?: number | null } | null>(null);
  const [err, setErr] = useState(''); const connect = Boolean(useShMe().data?.connectEnabled);
  const patch = async (m: ShMessage, b: Partial<ShMessage>) => { setErr(''); try { await shApi(`/messages/${m.id}`, 'PATCH', b); await q.refetch(); } catch (e) { setErr(messageError(e)); } };
  if (q.isLoading) return <p className="sh-sub">در حال دریافت…</p>;
  if (!q.data) return <p className="sh-err" role="alert">دریافت پیام‌ها انجام نشد.</p>;
  const row = (m: ShMessage, free = false) => <div className={`sh-tr msg${free ? ' free' : ''}`} key={m.id} data-testid="sh-msg-row">
    <button type="button" className="t" style={{ border: 0, background: 'none', textAlign: 'right', minWidth: 0, cursor: 'pointer', padding: 0 }} onClick={() => setEdit({ m })} data-testid={`sh-msg-edit-${m.id}`}>
      <b>{m.title}</b><span>{m.body}</span></button>
    <Switch on={m.showToday} label="نمایش در کارهای امروز" onChange={(v) => void patch(m, { showToday: v })} testId={`sh-msg-today-${m.id}`} />
    {!free ? <span className={`sh-ctl${connect ? '' : ' sh-off'}`}><CheckBox on={m.autoSend} label="ارسال خودکار" onChange={(v) => void patch(m, { autoSend: v })} testId={`sh-msg-auto-${m.id}`} />{connect ? null : <AfterConnect />}</span> : null}</div>;
  return <>
    <div className="sh-sech"><span /> <button type="button" className="sh-btn pri sm" onClick={() => setEdit({})} data-testid="sh-msg-new"><Plus aria-hidden="true" />پیام تازه</button></div>
    {err ? <p className="sh-err" role="alert">{err}</p> : null}
    <div className="sh-grp"><MessageCircle aria-hidden="true" />پیام‌های آزاد</div>
    <div className="sh-tbl" style={{ marginTop: 8 }}>
      <div className="sh-tr msg free hd"><span>پیام</span><span>در کارهای امروز کارشناسان</span></div>
      {q.data.free.length ? q.data.free.map((m) => row(m, true)) : <div className="sh-empty sh-sub">هنوز پیامی نیست.</div>}</div>
    <div className="sh-grp" style={{ margin: '24px 0 8px' }}><FileText aria-hidden="true" />پیام‌های طرح‌ها</div>
    <div className="sh-stack" style={{ gap: 16 }}>
      {q.data.plans.filter((x) => x.messages.length).map(({ plan, messages }) => <section className="sh-tbl" key={plan.id} data-testid={`sh-plan-${plan.id}`}>
        <div className="sh-row" style={{ background: 'var(--sh-tint)', padding: '10px 16px' }}><h3 className="sh-h3">{plan.name}</h3><span className="sh-sp" /><span className="sh-sub" style={{ color: 'var(--sh-navy)' }}>در بله: {plan.publicLabel}</span></div>
        <div className="sh-tr msg hd"><span>پیام</span><span>در کارهای امروز کارشناسان</span><span>ارسال خودکار</span></div>
        {messages.map((m) => row(m))}
        <div style={{ padding: '8px 16px' }}><button type="button" className="sh-btn sec sm" onClick={() => setEdit({ planId: plan.id })}><Plus aria-hidden="true" />پیام تازه برای {plan.name}</button></div>
      </section>)}
    </div>
    {q.data.plans.some((x) => !x.messages.length) ? <section className="sh-card" style={{ marginTop: 16 }} data-testid="sh-plans-empty">
      <h3 className="sh-h3" style={{ marginBottom: 8 }}>طرح‌های بدون پیام</h3>
      <div className="sh-row sh-wrap">{q.data.plans.filter((x) => !x.messages.length).map(({ plan }) => <button type="button" key={plan.id} className="sh-btn sec sm" onClick={() => setEdit({ planId: plan.id })}><Plus aria-hidden="true" />{plan.name}</button>)}</div>
    </section> : null}
    {edit ? <MessageEditor m={edit.m} planId={edit.planId} plans={q.data.plans.map((x) => x.plan)} vars={q.data.vars}
      onClose={() => setEdit(null)} onSaved={() => { setEdit(null); void q.refetch(); toast('پیام ذخیره شد.'); }} /> : null}
  </>;
}

function MessageEditor({ m, planId, plans, vars, onClose, onSaved }: { m?: ShMessage; planId?: number | null; plans: ShPlan[]; vars: string[]; onClose: () => void; onSaved: () => void }) {
  const [title, setTitle] = useState(m?.title ?? ''); const [body, setBody] = useState(m?.body ?? '');
  const [kind, setKind] = useState<'free' | 'plan'>(m?.kind ?? (planId ? 'plan' : 'free')); const [plan, setPlan] = useState<number | null>(m?.planId ?? planId ?? null);
  const [today, setToday] = useState(m?.showToday ?? true); const [auto, setAuto] = useState(m?.autoSend ?? false);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState(''); const [field, setField] = useState('');
  const save = async () => {
    if (!title.trim()) { setErr('نام پیام را بنویسید.'); setField('title'); return; }
    if (!body.trim()) { setErr('متن پیام را بنویسید.'); setField('body'); return; }
    if (kind === 'plan' && !plan) { setErr('طرح را انتخاب کنید.'); setField('planId'); return; }
    setBusy(true); setErr(''); setField('');
    try { await shApi(m ? `/messages/${m.id}` : '/messages', m ? 'PATCH' : 'POST', { title, body, kind, planId: kind === 'plan' ? plan : null, showToday: today, autoSend: kind === 'plan' && auto }); onSaved(); }
    catch (e) { setErr(messageError(e)); } finally { setBusy(false); }
  };
  const del = async () => { if (!m) return; setBusy(true); try { await shApi(`/messages/${m.id}`, 'DELETE'); onSaved(); } catch (e) { setErr(messageError(e)); setBusy(false); } };
  return <Wizard title={m ? 'ویرایش پیام' : 'پیام تازه'} onClose={onClose} testId="sh-msg-editor" foot={<>
    <button type="button" className="sh-btn pri" disabled={busy || body.length > 4096} onClick={() => void save()} data-testid="sh-msg-save">ذخیره پیام</button>
    <button type="button" className="sh-btn ghost" onClick={onClose}>انصراف</button>{m ? <button type="button" className="sh-btn ghost" onClick={() => void del()} disabled={busy}>بایگانی پیام</button> : null}</>}>
    <div className="sh-stack" style={{ gap: 14 }}>
      <label className="sh-frow"><span className="sh-lbl">نام پیام</span><div className={`sh-fld${field === 'title' ? ' err' : ''}`}><input value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} data-testid="sh-msg-title" /></div>{field === 'title' ? <p className="sh-err">{err}</p> : null}</label>
      <div className="sh-frow"><span className="sh-lbl">نوع</span><div className="sh-seg"><button type="button" className={kind === 'free' ? 'on' : ''} onClick={() => setKind('free')}>آزاد</button><button type="button" className={kind === 'plan' ? 'on' : ''} onClick={() => setKind('plan')}>مربوط به طرح</button></div></div>
      {kind === 'plan' ? <label className="sh-frow"><span className="sh-lbl">طرح</span><div className={`sh-fld${field === 'planId' ? ' err' : ''}`}><select value={plan ?? ''} onChange={(e) => setPlan(Number(e.target.value) || null)} data-testid="sh-msg-plan"><option value="">انتخاب طرح</option>{plans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></div>{field === 'planId' ? <p className="sh-err">{err}</p> : null}</label> : null}
      <label className="sh-frow"><span className="sh-lbl">متن پیام</span><textarea className="sh-ta" value={body} onChange={(e) => setBody(e.target.value)} rows={5} data-testid="sh-msg-body" />{field === 'body' ? <p className="sh-err">{err}</p> : null}<span className="sh-sub">{fa(body.length)} از ۴۰۹۶ نویسه</span></label>
      <div className="sh-row sh-wrap">{vars.map((v) => <button type="button" className="sh-chip tint" style={{ height: 44, cursor: 'pointer', border: 0 }} key={v} onClick={() => setBody((b) => b + ` ‹${v}›`)}><Plus size={14} aria-hidden="true" />{v}</button>)}</div>
      <div className="sh-stack" style={{ gap: 0 }}><Switch on={today} onChange={setToday} label="نمایش در کارهای امروز کارشناسان" />{kind === 'plan' ? <CheckBox on={auto} onChange={setAuto} label="ارسال خودکار هنگام اتصال مشتری به این طرح" /> : null}</div>
      {err && !field ? <p className="sh-err" role="alert">{err}</p> : null}
    </div>
  </Wizard>;
}
