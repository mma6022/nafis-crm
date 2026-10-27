import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'wouter';
import { AlertCircle, ArrowRight, Bot, Eye, FileText, Hand, Info, Moon, Paperclip, RotateCcw, ShieldAlert, UserRound } from 'lucide-react';
import { ErrorState, SkeletonPanel } from '@/components/CrmShell';
import { toast } from '@/hooks/use-toast';
import { baleFetch, baleWhen, faNum } from '@/features/bale/api';
import { AR_FILTERS, AR_KIND_FA, arReasonFa, shortName, type ArChat, type ArFilter, type ArItem, type ArOwner, type ArPair, type ArUnknownThread } from './api';

const errMsg = (e: unknown) => (e instanceof Error && e.message) || 'درخواست انجام نشد. دوباره تلاش کنید.';
type Msg = { id: number; dir: 'in' | 'out'; text: string | null; file: boolean; at: string; by: 'customer' | 'assistant' | 'expert'; byLabel: string; kind: string | null; failed: boolean };
type Thread = { title: string | null; unknown: boolean; owner: ArOwner; reason: string | null; at: string | null; by: string | null; customerId: number | null; msgs: Msg[] };

function useThread(item: ArItem | null, admin: { assistantId: number } | null) {
  const path = !item ? null : item.kind === 'customer' ? `/bale/customers/${item.customerId}/messages`
    : admin ? `/admin/bale/autoreply/pairs/${admin.assistantId}/unknown/${item.id}` : `/bale/me/autoreply/unknown/${item.id}`;
  return useQuery({
    queryKey: ['bale', 'ar', 'thread', path], enabled: Boolean(path), retry: false, refetchInterval: 15_000,
    queryFn: async (): Promise<Thread> => {
      if (item!.kind === 'customer') {
        const d = await baleFetch<ArChat>(path!);
        return { title: item!.name, unknown: false, owner: d.autoReply?.owner ?? item!.owner, reason: d.autoReply?.reason ?? item!.ownerReason, at: d.autoReply?.at ?? null, by: d.autoReply?.by ?? null, customerId: d.customerId,
          msgs: d.messages.map(m => ({ id: m.id, dir: m.direction, text: m.text, file: m.hasFile, at: m.createdAt, by: m.direction === 'in' ? 'customer' : m.auto ? 'assistant' : 'expert',
            byLabel: m.direction === 'in' ? 'مشتری' : m.expertName ?? 'کارشناس', kind: m.arKind ?? null, failed: m.status === 'failed' })) };
      }
      const d = await baleFetch<ArUnknownThread>(path!);
      return { title: null, unknown: true, owner: d.owner, reason: d.ownerReason, at: d.ownerAt, by: null, customerId: null,
        msgs: d.messages.filter(m => m.status !== 'cancelled').map(m => ({ id: m.id, dir: m.direction, text: m.text, file: m.hasFile, at: m.createdAt, by: m.by, byLabel: m.byLabel, kind: m.kind,
          failed: m.status === 'failed' || m.status === 'blocked' })) };
    },
  });
}

function ItemBadges({ it, expert }: { it: ArItem; expert: string }) {
  if (it.state === 'needs_expert') return <span className="bdg red"><ShieldAlert size={14} /> نیاز به {expert}</span>;
  if (it.state === 'failed') return <span className="bdg redo"><AlertCircle size={14} /> فرستاده نشد</span>;
  if (it.state === 'expert') return <span className="bdg blue"><Hand size={14} /> دست {expert}</span>;
  if (it.state === 'unanswered') return <span className="bdg gold">منتظر جواب</span>;
  if (it.state === 'waiting') return <span className="bdg mut"><Moon size={14} /> پیام شب رفت</span>;
  return <span className="bdg mut"><Bot size={14} /> مسعود جواب داد</span>;
}

/** Live view: conversation list + one thread. Expert: own account, takeover / give-back. Admin: read-only. */
export function AutoreplyLive({ pair, list, admin = false, onChanged }: { pair: ArPair; list: ArItem[]; admin?: boolean; onChanged: () => void }) {
  const qc = useQueryClient();
  const [filter, setFilter] = useState<ArFilter>('all');
  const [sel, setSel] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const expert = shortName(pair.expertName); const asst = pair.assistantName || 'مسعود';
  const shown = useMemo(() => list.filter(i => AR_FILTERS.find(f => f.key === filter)!.test(i.state)), [list, filter]);
  const cur = list.find(i => `${i.kind}:${i.id}` === sel) ?? null;
  const t = useThread(cur, admin ? { assistantId: pair.assistantId } : null);
  const counts = Object.fromEntries(AR_FILTERS.map(f => [f.key, list.filter(i => f.test(i.state)).length]));

  const act = async (what: 'takeover' | 'giveback') => {
    if (!cur) return; setBusy(true);
    try {
      const r = await baleFetch<{ cancelled: number }>(`/bale/me/autoreply/${cur.kind}/${cur.id}/${what}`, { method: 'POST', body: {} });
      toast({ title: what === 'takeover' ? 'گفتگو دست شماست' : `گفتگو به ${asst} برگشت`,
        description: what === 'takeover' ? `${asst} دیگر در این گفتگو جواب نمی‌دهد${r.cancelled ? `؛ ${faNum(r.cancelled)} پیام در صف لغو شد` : ''}.` : `از پیام بعدی مشتری، ${asst} جواب می‌دهد (با همان سقف‌ها و قانون‌ها).` });
    } catch (e) { toast({ title: 'انجام نشد', description: errMsg(e), variant: 'destructive' }); }
    finally { setBusy(false); onChanged(); void qc.invalidateQueries({ queryKey: ['bale', 'ar', 'thread'] }); }
  };

  const th = t.data;
  const owner = th?.owner ?? cur?.owner;
  const reason = th?.reason ?? cur?.ownerReason ?? null;
  const escalated = owner === 'expert' && String(reason ?? '').startsWith('escalated');
  return <div className={`lv${cur ? ' mth' : ''}`} data-testid="ar-live">
    <div className="cl" aria-label="گفتگوها">
      <div className="clh"><b>گفتگوهای بله</b>{pair.active ? <span className="live">{asst} فعال</span> : <span className="live off">{asst} خاموش</span>}</div>
      <div className="flt" role="group" aria-label="فیلتر گفتگوها">{AR_FILTERS.map(f => <button key={f.key} type="button" className={`ch${f.key === 'needs' && counts.needs ? ' rd' : ''}`}
        aria-pressed={filter === f.key} onClick={() => setFilter(f.key)} data-testid={`ar-filter-${f.key}`}>{f.label(expert)} <small>{faNum(counts[f.key] ?? 0)}</small></button>)}</div>
      {shown.length ? <ul>{shown.map(i => { const k = `${i.kind}:${i.id}`; return <li key={k}>
        <button type="button" className={`ci${i.state === 'needs_expert' ? ' st-esc' : ''}`} aria-current={sel === k} onClick={() => setSel(k)} data-testid={`ar-item-${i.kind}-${i.id}`}>
          <span className="r1"><b>{i.kind === 'unknown' ? <><span className="unk">{i.label ?? 'ناشناس'}</span>شماره‌ی ناشناس</> : i.name ?? 'مشتری'}</b><span className="tm">{baleWhen(i.lastAt)}</span></span>
          <p dir="auto">{i.lastBy === 'customer' ? '' : i.lastBy === 'assistant' ? `${asst}: ` : `${expert}: `}{i.lastText || '—'}</p>
          <span className="r2"><ItemBadges it={i} expert={expert} />{i.state === 'needs_expert' && arReasonFa(i.ownerReason) ? <span className="why2">{arReasonFa(i.ownerReason)}</span> : null}</span>
        </button></li>; })}</ul>
        : <div className="empty2"><b>{list.length ? 'در این فیلتر گفتگویی نیست' : 'هنوز گفتگویی نیست'}</b><span>{list.length ? 'فیلتر دیگری را انتخاب کنید.' : 'پیام‌های بله‌ی ۱۴ روز اخیر اینجا دیده می‌شود.'}</span></div>}
    </div>

    <section className="th" aria-label="گفتگو">
      {!cur ? <div className="empty2" style={{ minHeight: 360, alignContent: 'center' }}><b>یک گفتگو را انتخاب کنید</b><span>پیام‌های مشتری و جواب‌های {asst} اینجا دیده می‌شود.</span></div> : <>
        <div className="thh">
          <button type="button" className="btn btn-ghost back" onClick={() => setSel(null)} aria-label="برگشت به فهرست"><ArrowRight size={18} /></button>
          <div className="tt"><h2>{cur.kind === 'unknown' ? <><span className="unk">{cur.label ?? 'ناشناس'}</span>شماره‌ی ناشناس</> : cur.name ?? 'مشتری'}</h2>
            <span className="sub">{owner === 'expert' ? <><Hand size={13} /> دست {expert}</> : <><Bot size={13} /> {asst} جواب می‌دهد</>}</span></div>
          <div className="ta">
            {admin ? <span className="ro"><Eye size={14} /> فقط خواندنی</span>
              : owner === 'expert' ? <button type="button" className="btn" disabled={busy} onClick={() => void act('giveback')} data-testid="ar-giveback"><RotateCcw size={16} /> برگردون به {asst}</button>
              : <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void act('takeover')} data-testid="ar-takeover"><Hand size={16} /> خودم جواب می‌دم</button>}
            {cur.customerId ? <Link href={`/customers/${cur.customerId}`} className="btn" data-testid="ar-open-case"><FileText size={16} /> پرونده</Link> : null}
          </div>
        </div>
        {escalated ? <div className="esc" role="alert"><ShieldAlert size={18} /><div><b>این گفتگو به {expert} سپرده شد</b><p>{arReasonFa(reason)}؛ {asst} فقط پیام نگه‌دار فرستاد و دیگر جواب نمی‌دهد تا {admin ? 'کارشناس' : 'خودتان'} برگردانید.</p></div></div>
          : owner === 'expert' && reason === 'stale_backlog' ? <div className="esc gray"><Info size={18} /><div><b>پیام قدیمی</b><p>این پیام بیش از ۲۴ ساعت بی‌جواب مانده بود؛ {asst} جواب نداد و گفتگو دست {expert} است.</p></div></div>
          : owner === 'expert' ? <div className="esc blue"><Hand size={18} /><div><b>دست {expert}</b><p>{arReasonFa(reason) ?? 'گفتگو دست کارشناس است'}{th?.by ? ` · ${th.by}` : ''}{th?.at ? ` · ${baleWhen(th.at)}` : ''}. {asst} جواب نمی‌دهد؛ فقط دکمه‌ی «برگردون به {asst}» آن را برمی‌گرداند.</p></div></div>
          : !pair.active ? <div className="esc gray"><Info size={18} /><div><b>پاسخ خودکار خاموش است</b><p>{asst} در این گفتگو هم جواب نمی‌دهد.</p></div></div> : null}
        {t.isLoading ? <div style={{ padding: 14 }}><SkeletonPanel rows={3} /></div> : t.isError ? <div style={{ padding: 14 }}><ErrorState onRetry={() => t.refetch()} /></div>
          : <div className="msgs" role="log" aria-label="پیام‌ها" aria-live="polite">
            {th && th.msgs.length ? th.msgs.map(m => m.dir === 'in'
              ? <div key={m.id} className="bin" data-testid={`ar-msg-${m.id}`}>{m.file ? <span style={{ display: 'flex', gap: 4, alignItems: 'center' }}><Paperclip size={14} /> فایل</span> : null}<span dir="auto">{m.text}</span><span className="tm2">{baleWhen(m.at)}</span></div>
              : <div key={m.id} className={`mo${m.kind === 'hold' || m.kind === 'night' ? ' hold' : ''}${m.failed ? ' fail' : ''}`} data-testid={`ar-msg-${m.id}`}>
                <span className="mh2">{m.by === 'assistant' ? <span className="ptag"><Bot size={13} /> {m.byLabel.includes('خودکار') ? m.byLabel : `${asst} (خودکار)`}</span> : <span className="ptag kz"><UserRound size={13} /> {m.byLabel}</span>}
                  {m.kind && AR_KIND_FA[m.kind] ? <span className="lab">{AR_KIND_FA[m.kind]}</span> : null}</span>
                <div className="bub">{m.file ? <span style={{ display: 'flex', gap: 4, alignItems: 'center' }}><Paperclip size={14} /> فایل</span> : null}<span dir="auto">{m.text}</span><span className="tm2">{baleWhen(m.at)}</span></div>
                {m.failed ? <span className="fl"><AlertCircle size={14} /> فرستاده نشد</span> : null}
              </div>) : <span className="sys2">پیامی نیست</span>}
          </div>}
        <div className="comp">{admin ? <span><Eye size={16} /> نمای مدیر فقط خواندنی است.</span>
          : <span><Info size={16} /> {cur.customerId ? 'برای نوشتن، از اپ بله یا بخش «گفتگوی بله» در پرونده جواب بدهید؛ با جواب شما گفتگو دست خودتان می‌شود.' : 'برای این شماره از اپ بله جواب بدهید؛ با جواب شما گفتگو دست خودتان می‌شود.'}</span>}</div>
      </>}
    </section>
  </div>;
}
