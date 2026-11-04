/** Customer file «موارد اجباری» (design v1.2 scenes file_row / file_items_history): compact row, empty items red + «تکمیل»,
 *  «تاریخچه» with the approver, and a «N پیشنهاد تغییر» badge to the later call where the expert decides. */
import { useState } from 'react';
import { Link } from 'wouter';
import { ChevronDown, Clock, Flag, Pencil, X } from 'lucide-react';
import { CsControl, countLine } from './controls';
import { dayText, fa, shortDay, useCsConfig, useCsFile, useCsFileSet, valueText, type CsHist, type CsKey } from './api';
import './cs.css';

const srcLine = (m: CsHist) => `${m.source}${m.at ? `، ${shortDay(m.at)}` : ''}${m.by && m.sourceKey === 'proposal' ? `؛ تأیید: ${m.by}` : ''}`;

export default function CsFileItems({ customerId }: { customerId: number }) {
  const cfg = useCsConfig(); const on = cfg.data?.enabled === true;
  const q = useCsFile(customerId, on);
  const set = useCsFileSet(customerId);
  const [full, setFull] = useState(false); const [open, setOpen] = useState<CsKey | null>(null);
  if (!on || !q.data || !q.data.hasFile) return null;
  const d = q.data;
  const badge = d.pendingCount > 0 && d.pendingEventId ? <Link className="chip g sgbd" href={`/call-view/${d.pendingEventId}`} data-testid="cs-file-badge"><Pencil className="i" aria-hidden="true" />{fa(d.pendingCount)} پیشنهاد تغییر</Link> : null;
  const complete = (k: CsKey) => { setFull(true); setOpen(k); };
  return <section className="csf card cs-card mrow" aria-labelledby="mrH" data-testid="cs-file" data-view={full ? 'full' : 'compact'}>
    <div className="sh"><h3 id="mrH"><Flag className="i" aria-hidden="true" />موارد اجباری</h3><span className={`chip ${d.count === d.total ? 's' : 'r'}`} data-testid="cs-file-count">{countLine(d.count, d.total)}</span>{badge}<span className="sp" />
      <button type="button" className="btn lk sm" aria-expanded={full} onClick={() => { setFull(!full); setOpen(null); }} data-testid="cs-file-toggle"><ChevronDown className="i" aria-hidden="true" />{full ? 'نمای فشرده' : 'جزئیات و تاریخچه'}</button></div>
    {!full ? <ul className="mcomp">{d.items.map((i) => <li key={i.key} className={i.value == null ? 'miss' : ''} data-testid={`cs-file-${i.key}`}><small>{i.label}</small>
      <b>{i.value == null ? 'پرسیده نشد' : valueText(i.key, i.value)}</b>
      {i.value == null && d.canEdit && i.key !== 'planType' ? <button type="button" className="btn lk sm" aria-label={`تکمیل ${i.label}`} onClick={() => complete(i.key)} data-testid={`cs-file-complete-${i.key}`}><Pencil className="i" aria-hidden="true" />تکمیل</button> : null}</li>)}</ul>
      : <ul className="mlist hl">{d.items.map((i) => <li key={i.key} className={`mi ${i.value == null ? 'm' : ''}`} data-testid={`cs-file-${i.key}`}>
        <div className="mi-h"><b>{i.label}</b>{i.value != null ? <><span className="mv">{valueText(i.key, i.value)}</span>{i.meta ? <small className="hsrc">{srcLine(i.meta)}</small> : null}</>
          : <span className="chip r mtag"><X className="i" aria-hidden="true" />پرسیده نشد</span>}
          {d.canEdit && i.key !== 'planType' && open !== i.key ? <button type="button" className="btn lk sm ed" onClick={() => setOpen(i.key)} data-testid={`cs-file-edit-${i.key}`}><Pencil className="i" aria-hidden="true" />{i.value == null ? 'تکمیل' : 'اصلاح'}</button> : null}</div>
        {open === i.key ? <div className="mi-c"><CsControl k={i.key} value={i.value} onChange={(v) => set.mutate({ key: i.key, value: v }, { onSuccess: () => setOpen(null) })} />
          <button type="button" className="btn lk sm" onClick={() => setOpen(null)}>بستن</button></div> : null}
        {i.history.length ? <details className="hx" open data-testid={`cs-hist-${i.key}`}><summary><Clock className="i" aria-hidden="true" />تاریخچه</summary><ul>{i.history.map((h, n) => <li key={n} className={h.rejected ? 'rj' : undefined} data-status={h.status ?? 'applied'} data-testid={`cs-hist-${i.key}-${n}`}>
          <b>{valueText(i.key, h.value) || 'بی‌مقدار'}</b>{h.rejected ? <span className="chip" data-testid={`cs-hist-rj-${i.key}`}><X className="i" aria-hidden="true" />اعمال نشد</span> : null}{h.at ? <span>{dayText(h.at)}</span> : null}
          {h.eventId ? <Link href={`/call-view/${h.eventId}`}>{h.source}</Link> : <span>{h.source}</span>}{h.by ? <span>{h.rejected ? 'رد' : h.sourceKey === 'proposal' ? 'تأیید' : 'ثبت'}: {h.by}</span> : null}</li>)}</ul></details> : null}
      </li>)}</ul>}
    {set.error instanceof Error ? <p className="err" role="alert">{set.error.message}</p> : null}
  </section>;
}
