import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BookOpen, Eye, Pencil, Search, Trash2 } from 'lucide-react';
import { Modal } from '@/components/DataTools';
import { ErrorState, SkeletonPanel } from '@/components/CrmShell';
import { toast } from '@/hooks/use-toast';
import { baleFetch, baleWhen, faNum } from '@/features/bale/api';
import { AR_LEARNED_MAX, type ArLearned } from './api';

const errMsg = (e: unknown) => (e instanceof Error && e.message) || 'درخواست انجام نشد. دوباره تلاش کنید.';
type Target = { mode: 'expert' } | { mode: 'admin'; assistantId: number };

/** AR30 «جواب‌های آموخته‌شده»: rows exist only after the expert ticked «برای دفعه‌های بعد هم همین جواب رو بده». Masoud reads ACTIVE rows
 *  through the runner route. Expert: own rows. Admin: per pair. No manual «جواب تازه» in AR30 (rows come only from answered questions). */
export function LearnedAnswers({ target, expertName }: { target: Target; expertName: string }) {
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<{ item: ArLearned; edit: boolean } | null>(null);
  const [del, setDel] = useState<ArLearned | null>(null);
  const base = target.mode === 'admin' ? `/admin/bale/autoreply/pairs/${target.assistantId}/learned` : '/bale/me/autoreply/learned';
  const itemPath = (id: number) => target.mode === 'admin' ? `/admin/bale/autoreply/learned/${id}` : `/bale/me/autoreply/learned/${id}`;
  const list = useQuery({ queryKey: ['bale', 'ar', 'learned', base, q.trim()], retry: false,
    queryFn: () => baleFetch<{ items: ArLearned[]; max: number }>(`${base}${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ''}`) });
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['bale', 'ar', 'learned'] }); void qc.invalidateQueries({ queryKey: ['bale', 'ar', 'admin'] }); void qc.invalidateQueries({ queryKey: ['bale', 'ar', 'me'] }); };
  const items = list.data?.items ?? [];
  return <div className="lnw" data-testid="ar-learned">
    <div className="card" style={{ padding: 14 }}>
      <div className="lnt"><BookOpen size={18} /><b>جواب‌های آموخته‌شده</b><span className="muted" style={{ fontSize: 13 }}>{faNum(items.length)} مورد</span></div>
      <p className="muted" style={{ margin: '6px 0 10px', fontSize: 13.5 }}>هر بار {expertName} به سؤالی که مسعود نمی‌دانست جواب داد و تیک «برای دفعه‌های بعد هم همین جواب رو بده» را زد، آن جواب اینجا ذخیره می‌شود و مسعود دفعه‌ی بعد همان را می‌فرستد (فقط جواب‌های «فعال»؛ بدون مبلغ و بدون قول).</p>
      <div className="lnt"><Search size={16} /><input className="input" type="search" placeholder="جستجو در سؤال و جواب…" value={q} maxLength={80} onChange={e => setQ(e.target.value)} data-testid="ar-learned-search" /></div>
    </div>
    {list.isLoading ? <SkeletonPanel rows={3} /> : list.isError ? <ErrorState onRetry={() => list.refetch()} />
      : items.length ? <ul className="lnl">{items.map(l => <li key={l.id} className={`lnc${l.active ? '' : ' off'}`} data-testid={`ar-learned-${l.id}`}>
        <span className="q"><span dir="auto">{l.question}</span>{l.active ? null : <span className="bdg mut">غیرفعال</span>}</span>
        <p dir="auto">{l.answer}</p>
        <span className="meta"><span>{l.updatedBy ?? expertName} · {baleWhen(l.updatedAt)}</span><span>آخرین استفاده: {l.lastUsedAt ? baleWhen(l.lastUsedAt) : '—'}</span><span>{faNum(l.useCount)} بار</span></span>
        <span className="acts">
          <button type="button" className="btn btn-ghost" onClick={() => setOpen({ item: l, edit: false })} data-testid={`ar-learned-view-${l.id}`}><Eye size={15} /> مشاهده</button>
          <button type="button" className="btn btn-ghost" onClick={() => setOpen({ item: l, edit: true })} data-testid={`ar-learned-edit-${l.id}`}><Pencil size={15} /> ویرایش</button>
          <button type="button" className="btn btn-ghost" style={{ color: 'var(--nf-danger)' }} onClick={() => setDel(l)} data-testid={`ar-learned-del-${l.id}`}><Trash2 size={15} /> حذف</button>
        </span></li>)}</ul>
      : <div className="empty2" data-testid="ar-learned-empty"><b>{q.trim() ? 'چیزی پیدا نشد' : 'هنوز جوابی آموخته نشده'}</b><span>{q.trim() ? 'عبارت دیگری را جستجو کنید.' : `وقتی مسعود جواب سؤالی را نداند، از ${expertName} می‌پرسد. اگر ${expertName} موقع جواب دادن تیک «برای دفعه‌های بعد هم همین جواب رو بده» را بزند، جواب اینجا می‌آید.`}</span></div>}
    {open ? <LearnedModal key={`${open.item.id}-${open.edit}`} item={open.item} edit={open.edit} path={itemPath(open.item.id)} onClose={() => setOpen(null)} onEdit={() => setOpen({ item: open.item, edit: true })} onSaved={it => { setOpen(null); refresh(); toast({ title: it.active ? 'ذخیره شد' : 'ذخیره شد · غیرفعال' }); }} /> : null}
    {del ? <Modal title="حذف جواب آموخته‌شده؟" onClose={() => setDel(null)} testId="ar-learned-del">
      <p style={{ margin: '0 0 12px' }}>«{del.question}» حذف می‌شود و مسعود دیگر از آن استفاده نمی‌کند. سابقه‌ی پیام‌های رفته عوض نمی‌شود.</p>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button type="button" className="btn" onClick={() => setDel(null)}>انصراف</button>
        <button type="button" className="btn btn-primary" style={{ background: 'var(--nf-danger)' }} data-testid="ar-learned-del-confirm" onClick={async () => {
          try { await baleFetch(itemPath(del.id), { method: 'DELETE' }); toast({ title: 'حذف شد' }); setDel(null); refresh(); }
          catch (e) { toast({ title: 'حذف نشد', description: errMsg(e), variant: 'destructive' }); } }}>حذف</button>
      </div></Modal> : null}
  </div>;
}

function LearnedModal({ item, edit, path, onClose, onEdit, onSaved }: { item: ArLearned; edit: boolean; path: string; onClose: () => void; onEdit: () => void; onSaved: (it: ArLearned) => void }) {
  const [question, setQuestion] = useState(item.question); const [answer, setAnswer] = useState(item.answer); const [active, setActive] = useState(item.active);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const put = async (body: Record<string, unknown>) => {
    setBusy(true); setErr(null);
    try { const r = await baleFetch<{ item: ArLearned }>(path, { method: 'PUT', body }); onSaved(r.item); }
    catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };
  return <Modal title={edit ? 'ویرایش جواب آموخته‌شده' : 'جواب آموخته‌شده'} eyebrow={`${item.updatedBy ?? ''} · ${baleWhen(item.updatedAt)}`} onClose={onClose} testId="ar-learned-item">
    <div className="arx lne" dir="rtl">
      {edit ? <>
        <label style={{ display: 'grid', gap: 4 }}><b>سؤال</b><textarea className="input" dir="auto" rows={2} maxLength={AR_LEARNED_MAX} value={question} onChange={e => setQuestion(e.target.value)} data-testid="ar-learned-q" /></label>
        <label style={{ display: 'grid', gap: 4 }}><b>جواب</b><textarea className="input" dir="auto" maxLength={AR_LEARNED_MAX} value={answer} onChange={e => setAnswer(e.target.value)} data-testid="ar-learned-a" /></label>
        <span className="cnt">{faNum(answer.length)} / {faNum(AR_LEARNED_MAX)} · بدون مبلغ و بدون قول</span>
      </> : <><div><div className="eyebrow">سؤال</div><p dir="auto" style={{ margin: 0 }}>{item.question}</p></div><div><div className="eyebrow">جواب</div><p dir="auto" style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{item.answer}</p></div>
        <span className="muted" style={{ fontSize: 13 }}>آخرین استفاده: {item.lastUsedAt ? baleWhen(item.lastUsedAt) : '—'} · {faNum(item.useCount)} بار</span></>}
      <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}><input type="checkbox" role="switch" checked={active} onChange={e => setActive(e.target.checked)} data-testid="ar-learned-active" /><b>فعال</b><small className="muted">غیرفعال یعنی مسعود از این جواب استفاده نمی‌کند.</small></label>
      {err ? <div role="alert" style={{ color: 'var(--nf-danger)', fontWeight: 700, fontSize: 13.5 }}>{err}</div> : null}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
        <button type="button" className="btn" onClick={onClose}>بستن</button>
        {!edit ? <button type="button" className="btn" onClick={onEdit}><Pencil size={15} /> ویرایش</button> : null}
        <button type="button" className="btn btn-primary" disabled={busy || (edit ? (!question.trim() || !answer.trim()) : active === item.active)} data-testid="ar-learned-save"
          onClick={() => void put(edit ? { question: question.trim(), answer: answer.trim(), active } : { active })}>ذخیره</button>
      </div>
    </div>
  </Modal>;
}
