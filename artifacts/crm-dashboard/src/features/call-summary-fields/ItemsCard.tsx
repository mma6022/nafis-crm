/** Call view «موارد اجباری» (design v1.2 scenes view_auto/view_jump/view_edit/fc_saved/sim_manual/processing/later_call_summary/change_applied).
 *  First call: all 7 items with tags; later call: only what was said, plus «اعمال در پرونده» / «نه» per differing item. The file never changes without a click here. */
import { useState } from 'react';
import { Check, Flag, Pencil, RefreshCw, X } from 'lucide-react';
import { CsControl, CsJump, CsTag, DocsChip, MissLine, countLine } from './controls';
import { dayTimeText, fa, useCsCall, useCsCallAct, useCsConfig, valueText, type CsCall, type CsItem, type CsKey, type CsProposal } from './api';
import './cs.css';

const hasVal = (i: CsItem) => i.state === 'n' || (['a', 'c', 'e'].includes(i.state) && i.value != null);
export function CsValue({ k, v, state, text }: { k: CsKey; v: unknown; state?: string; text?: string | null }) {
  if (v == null || state === 'm' || state === 'x' || state === 'n') return state === 'u' && text ? <span className="mv nil">{text}</span> : <span className="mv nil">بی‌مقدار</span>;
  if (k === 'docs' && Array.isArray(v)) return <><DocsChip d={v as string[]} /><span className="mv">{v.length ? valueText(k, v).split(': ')[1] : 'هیچ‌کدام آماده نیست'}</span></>;
  return <span className="mv">{valueText(k, v)}</span>;
}

/** Scrolls the transcript line at `at` seconds into view and marks it (both transcript views use data-testid ct-line-<i>). */
export function jumpTo(at: number, starts: number[]) {
  let k = -1; starts.forEach((s, i) => { if (s <= at + 0.5) k = i; }); if (k < 0) k = 0;
  document.querySelectorAll('[data-cs-hit]').forEach((e) => e.removeAttribute('data-cs-hit'));
  const el = document.querySelector<HTMLElement>(`[data-testid="ct-line-${k}"]`);
  if (el) { el.setAttribute('data-cs-hit', '1'); el.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
}

export default function CsItemsCard({ eventId, starts }: { eventId: number; starts: number[] }) {
  const cfg = useCsConfig(); const on = cfg.data?.enabled === true;
  const q = useCsCall(eventId, on);
  if (!on || !q.data || q.data.kind === 'none') return null;
  return <section className="csf card cs-card" aria-labelledby="mcH" data-testid="cs-card" data-kind={q.data.kind}><CsBody d={q.data} starts={starts} /></section>;
}

function CsBody({ d, starts }: { d: CsCall; starts: number[] }) {
  const act = useCsCallAct(d.eventId);
  const allX = d.items.length > 0 && d.items.every((i) => i.state === 'x') && d.canEdit;
  const [open, setOpen] = useState<Set<CsKey>>(new Set());
  const [cur, setCur] = useState<CsKey | null>(null);
  const isOpen = (k: CsKey) => allX || open.has(k);
  const toggle = (k: CsKey, v: boolean) => setOpen((s) => { const n = new Set(s); if (v) n.add(k); else n.delete(k); return n; });
  const later = d.kind === 'later';
  const props = new Map<CsKey, CsProposal>(d.proposals.map((p) => [p.key, p]));
  const pend = d.proposals.filter((p) => p.status === 'pending');
  const err = act.error instanceof Error ? act.error.message : null;
  const miss = d.items.filter((i) => !hasVal(i)).length;
  return <>
    {later ? <><div className="sh mchk top"><h3 id="mcH"><Flag className="i" aria-hidden="true" />موارد گفته‌شده در این تماس</h3><span className="chip">تماس بعدی؛ چیزی پرسیده نمی‌شود</span><span className="sp" />
      {d.canDecide && pend.length >= 2 ? <button type="button" className="btn gh sm" onClick={() => act.mutate({ t: 'all' })} data-testid="cs-apply-all"><Check className="i" aria-hidden="true" />اعمال همه در پرونده ({fa(pend.length)})</button> : null}</div>
      {pend.length ? <p className="sgn" data-testid="cs-sgn">{fa(pend.length)} مورد با پرونده فرق دارد؛ پرونده فقط با تأیید تو عوض می‌شود.</p> : null}</>
      : <div className="sh mchk top"><h3 id="mcH"><Flag className="i" aria-hidden="true" />موارد اجباری</h3><span className={`chip ${d.count === d.total ? 's' : 'r'}`} data-testid="cs-count">{countLine(d.count, d.total)}</span>
        {d.required ? null : <span className="chip">در این تماس اجباری نیست</span>}<span className="sp" />
        {d.canEdit && d.items.some((i) => i.state === 'a') ? <button type="button" className="btn gh sm" onClick={() => act.mutate({ t: 'confirm' })} data-testid="cs-confirm"><Check className="i" aria-hidden="true" />همه درست است</button> : null}</div>}
    {d.formSavedAt && !later ? <><p className="chip s" role="status" data-testid="cs-saved"><Check className="i" aria-hidden="true" />ثبت شد، {dayTimeText(d.formSavedAt)}</p><MissLine n={miss} /></> : null}
    {d.extraction === 'processing' && !later ? <p className="muted" role="status" data-testid="cs-processing"><RefreshCw className="i" aria-hidden="true" /> موارد اجباری را دستی پر کن؛ وقتی متن آماده شد، چیزی که دستی زده‌ای عوض نمی‌شود.</p> : null}
    {later && !d.items.length ? <p className="muted" data-testid="cs-none-said">در این تماس از موارد اجباری چیزی گفته نشد.</p> : null}
    <ul className="mlist">{d.items.map((i) => <Row key={i.key} i={i} d={d} open={isOpen(i.key)} later={later} p={props.get(i.key)} cur={cur === i.key}
      onOpen={(v) => toggle(i.key, v)} onJump={i.atSec != null && starts.length ? () => { setCur(i.key); jumpTo(i.atSec!, starts); } : undefined} act={act} />)}</ul>
    {err ? <p className="err" role="alert" data-testid="cs-err">{err}</p> : null}
  </>;
}

function Row({ i, d, open, later, p, cur, onOpen, onJump, act }: { i: CsItem; d: CsCall; open: boolean; later: boolean; p?: CsProposal; cur: boolean;
  onOpen: (v: boolean) => void; onJump?: () => void; act: ReturnType<typeof useCsCallAct> }) {
  const [na, setNa] = useState(false); const [reason, setReason] = useState(''); const [rErr, setRErr] = useState('');
  const edit = d.canEdit && i.key !== 'planType';
  const set = (v: unknown) => act.mutate({ t: 'set', key: i.key, body: { value: v } }, { onSuccess: () => { if (i.state !== 'x') onOpen(false); } });
  const sendNa = () => { if (!reason.trim()) { setRErr('دلیل کوتاه را بنویس.'); return; } act.mutate({ t: 'set', key: i.key, body: { noAnswer: true, reason: reason.trim() } }, { onSuccess: () => { setNa(false); onOpen(false); } }); };
  const jmp = i.atSec != null && ['a', 'u', 'c'].includes(i.state) ? <CsJump k={i.key} at={i.atSec} current={cur} onJump={onJump} /> : null;
  return <li className={`mi ${i.state}`} data-testid={`cs-item-${i.key}`} data-state={i.state}>
    <div className="mi-h"><b>{i.label}</b><CsValue k={i.key} v={i.value} state={i.state} text={i.text} /><CsTag s={i.state} k={i.key} />{jmp}
      {edit && !open ? <button type="button" className="btn lk sm ed" aria-label={`${i.state === 'm' && !later ? 'تکمیل' : 'اصلاح'} ${i.label}`} onClick={() => onOpen(true)} data-testid={`cs-edit-${i.key}`}>
        <Pencil className="i" aria-hidden="true" />{i.state === 'm' && !later ? 'تکمیل' : 'اصلاح'}</button> : null}</div>
    {i.state === 'n' && i.reason ? <p className="hsrc" data-testid={`cs-reason-${i.key}`}>دلیل: {i.reason}</p> : null}
    {open && edit ? <div className="mi-c"><CsControl k={i.key} value={i.state === 'n' ? null : i.value} onChange={set} />
      {!later && !hasVal(i) ? na ? <div className="nar"><label className="flab" htmlFor={`cs-na-${i.key}`}>دلیل کوتاه</label>
        <input id={`cs-na-${i.key}`} className="inp" type="text" maxLength={120} value={reason} onChange={(e) => { setReason(e.target.value); setRErr(''); }} data-testid={`cs-na-reason-${i.key}`} />
        {rErr ? <p className="err" role="alert">{rErr}</p> : null}
        <div className="sgb"><button type="button" className="btn gh sm" onClick={sendNa} data-testid={`cs-na-save-${i.key}`}><Check className="i" aria-hidden="true" />ثبت «مشتری جواب نداد»</button>
          <button type="button" className="btn lk sm" onClick={() => setNa(false)}><X className="i" aria-hidden="true" />برگرداندن «مشتری جواب نداد»</button></div></div>
        : <button type="button" className="btn lk sm" onClick={() => setNa(true)} data-testid={`cs-na-${i.key}`}>مشتری جواب نداد</button> : null}
      {i.state !== 'x' ? <button type="button" className="btn lk sm" onClick={() => onOpen(false)} data-testid={`cs-close-${i.key}`}>بستن</button> : null}</div> : null}
    {later && p ? <Proposal p={p} k={i.key} canDecide={d.canDecide} act={act} /> : null}
  </li>;
}

function Proposal({ p, k, canDecide, act }: { p: CsProposal; k: CsKey; canDecide: boolean; act: ReturnType<typeof useCsCallAct> }) {
  if (p.status === 'applied') return <p className="sgok" role="status" data-testid={`cs-applied-${k}`}><Check className="i" aria-hidden="true" />در پرونده اعمال شد؛ تأیید: {p.decidedBy ?? 'کارشناس'}</p>;
  return <div className={`csg${p.status === 'rejected' ? ' no' : ''}`} data-testid={`cs-prop-${k}`} data-status={p.status}>
    <p className="sgv"><span><small>در پرونده</small><b>{p.fileValue == null ? 'بی‌مقدار' : valueText(k, p.fileValue)}</b></span><span className="sga" aria-hidden="true">←</span>
      <span><small>در این تماس</small><b>{valueText(k, p.newValue)}</b></span></p>
    {p.status === 'rejected' ? <p className="dsl"><span className="chip"><X className="i" aria-hidden="true" />اعمال نشد</span><small className="muted">پرونده همان مقدار قبلی را نگه داشت</small></p>
      : canDecide ? <div className="sgb"><button type="button" className="btn pri sm" onClick={() => act.mutate({ t: 'apply', id: p.id })} data-testid={`cs-apply-${k}`}><Check className="i" aria-hidden="true" />اعمال در پرونده</button>
        <button type="button" className="btn gh sm" onClick={() => act.mutate({ t: 'reject', id: p.id })} data-testid={`cs-reject-${k}`}>نه</button></div>
        : <small className="muted">تأیید با کارشناس همین تماس است.</small>}
  </div>;
}

/** result_voip: compact chips of what a later VoIP call said; nothing required here. */
export function CsResultChips({ eventId }: { eventId: number | null }) {
  const cfg = useCsConfig(); const on = cfg.data?.enabled === true;
  const q = useCsCall(eventId, on);
  if (!on || !q.data || q.data.kind !== 'later' || !q.data.items.length) return null;
  return <section className="csf rcs" aria-labelledby="csRc" data-testid="cs-result-chips"><div className="sh"><h3 id="csRc"><Flag className="i" aria-hidden="true" />موارد گفته‌شده در این تماس</h3><span className="chip">تماس بعدی؛ چیزی پرسیده نمی‌شود</span></div>
    <ul>{q.data.items.map((i) => <li key={i.key} data-testid={`cs-rc-${i.key}`}><b>{i.label}</b><CsValue k={i.key} v={i.value} state={i.state} text={i.text} /><CsTag s={i.state} /></li>)}</ul></section>;
}
