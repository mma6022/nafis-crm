/* «فضای کار بله» الف — ستون زمینهٔ مشتری (چپ در ۱۲۸۰) یا زبانه‌های پرونده / اعتبار / تماس‌ها (۳۹۰). Compact, no explanation boxes.
   Full phone + national id only for a customer the viewer may see (server decides: restricted = name + expert only). */
import { Sep } from './Sep';
import { Link } from 'wouter';
import { colourClass, CreditCard } from '@/features/credit-panel/CreditCard';
import { fd, faNum, jDate, toman, type BwsAssets, type BwsChatCtx, type BwsContext } from './api';

type Full = Extract<BwsContext, { restricted: false }>;
const Row = ({ k, v, chip }: { k: string; v: React.ReactNode; chip?: React.ReactNode }) => v == null || v === '' ? null : <div className="bws-kv"><span className="k">{k}</span><b>{v}</b>{chip}</div>;
const CALL_RESULT_FA: Record<string, string> = {
  answered: 'جواب داد', no_answer: 'جواب نداد', 'no-answer': 'جواب نداد', missed: 'جواب نداد',
  callback: 'گفت بعداً زنگ بزنید', wrong_number: 'شماره اشتباه', busy: 'اشغال', completed: 'انجام شد', failed: 'ناموفق',
};
const callResultFa = (r: string) => CALL_RESULT_FA[r] ?? (/^[a-z][a-z0-9_]*$/i.test(r) ? 'تماس' : r);

export function FileBlock({ c }: { c: Full }) {
  const d = c.dossier;
  return <section className="bws-blk" aria-label="پرونده‌ی مشتری"><h3>پروندهٔ مشتری</h3>
    {d && (d.job || d.purpose || d.amountToman || d.guarantor) ? <>
      <Row k="شغل" v={d.job} chip={d.fromSite ? <span className="bws-chip">از سایت</span> : null} />
      <Row k="برای" v={d.purpose} />
      <Row k="مبلغ" v={d.amountToman ? `${faNum(d.amountToman)} تومان` : null} />
      <Row k="ضامن" v={d.guarantor} />
    </> : <p className="bws-mut">هنوز چیزی در پرونده ثبت نشده است.</p>}
  </section>;
}
/** «اعتبار»: with the released credit panel (flag.credit_panel_v1) the SAME card as Today — rank/score, cheques, cheque colour, active loans,
 *  «آخرین استعلام: X روز پیش» and its own «استعلام جدید». Without it: the short summary the customer file already has. */
export function CreditBlock({ c }: { c: Full; toast?: (t: string) => void }) {
  const k = c.credit;
  if (k.panel) return <div className="bws-blk bws-cp" data-testid="bws-credit-panel"><CreditCard key={`bws-cp-${c.customer.id}`} customerId={c.customer.id} wizard /></div>;
  return <section className="bws-blk" aria-label="اعتبارسنجی"><h3>اعتبارسنجی</h3>
    <div className="bws-chips">
      {k.grade ? <span className="bws-chip">رتبه {fd(k.grade)}</span> : <span className="bws-chip mut">رتبه ثبت نشده</span>}
      {k.colour ? <span className={`bws-chip cc ${colourClass(k.colour, k.colourCode ?? undefined)}`}>رنگ چک: {k.colour}</span> : null}
      {k.bounced != null ? <span className="bws-chip">{k.bounced ? `${fd(k.bounced)} چک برگشتی` : 'بدون چک برگشتی'}</span> : c.dossier?.bounced === true ? <span className="bws-chip">چک برگشتی یا معوق دارد</span> : null}
      {k.debtRial != null ? <span className="bws-chip">مانده بدهی {toman(k.debtRial)}</span> : null}
    </div>
    {k.lastAt ? <p className="bws-mut">آخرین استعلام: {jDate(k.lastAt)}</p> : <p className="bws-mut">هنوز استعلامی ثبت نشده است.</p>}
  </section>;
}
export function CasesBlock({ c }: { c: Full }) {
  return <section className="bws-blk" aria-label="پرونده‌های تسهیلات"><h3>پرونده‌های تسهیلات</h3>
    {c.cases.length ? c.cases.map((a) => <Link key={a.id} className="bws-case" href={`/loan-applications/${a.id}`}><b>{a.plan ?? 'طرح نامشخص'}</b><span>پرونده #{fd(a.id)}{a.status ? ` · ${a.status}` : ''}{a.amount ? ` · ${faNum(a.amount)} تومان` : ''}</span></Link>)
      : <p className="bws-mut">پرونده‌ای ثبت نشده است.</p>}
  </section>;
}
export function CallsBlock({ c }: { c: Full }) {
  const items = [
    ...c.calls.map((l) => ({ at: l.at, t: l.result ? <>{jDate(l.at)}<Sep />{callResultFa(l.result)}</> : jDate(l.at), s: l.note })),
    ...c.invites.filter((i) => i.line).map((i) => ({ at: i.at, t: <>{jDate(i.at)}<Sep />دعوت به بله</>, s: i.line })),
    ...c.explained.map((e) => ({ at: e.at, t: <>{jDate(e.at)}<Sep />طرح‌های توضیح‌داده‌شده</>, s: `${e.name}${e.by ? ` — ${e.by}` : ''}` })),
  ].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 8);
  return <section className="bws-blk" aria-label="تماس‌ها"><h3>تماس‌ها و تاریخچه</h3>
    {items.length ? <ul className="bws-hist">{items.map((x, i) => <li key={i}><b>{x.t}</b>{x.s ? <span>{x.s}</span> : null}</li>)}</ul> : <p className="bws-mut">هنوز تماسی ثبت نشده است.</p>}
  </section>;
}
export function AssetsBlock({ a }: { a: BwsAssets }) {
  return <section className="bws-blk" aria-label="داشته‌های من"><h3>داشته‌های من</h3>
    <div className="bws-kv"><span className="k">پیام‌های آماده</span><b>{a.quick.length ? fd(a.quick.length) : '—'}</b></div>
    <div className="bws-kv"><span className="k">شرایط طرح</span><b>{a.plans.length ? a.plans.map((p) => p.name).join('، ') : '—'}</b></div>
    {a.training.length ? <ul className="bws-files">{a.training.map((t) => <li key={t.id}><a href={t.kind === 'link' ? t.url : `${(import.meta.env.BASE_URL || '/').replace(/\/$/, '')}${t.url}`} target="_blank" rel="noreferrer noopener">{t.title}</a><span className="bws-chip exp">کارشناس</span></li>)}</ul>
      : <p className="bws-mut">فایل آموزشی کارشناس نیست.</p>}
  </section>;
}
/** Desktop column (≥1024) or one mobile tab. */
export function BwContext({ data, only, toast }: { data: BwsChatCtx | undefined; only?: 'file' | 'credit' | 'calls'; toast: (t: string) => void }) {
  const cls = only ? 'bws-ctx tab' : 'pane cp bws-ctx';
  if (!data) return <aside className={cls} aria-busy="true"><span className="bbsk" /><span className="bbsk" /></aside>;
  const c = data.context;
  if (!c) return <aside className={cls} aria-label="زمینه‌ی مشتری"><section className="bws-blk"><h3>زمینهٔ مشتری</h3><p className="bws-mut">این گفتگو هنوز به پرونده وصل نیست.</p></section><AssetsBlock a={data.assets} /></aside>;
  if (c.restricted) return <aside className={cls} aria-label="زمینه‌ی مشتری"><section className="bws-blk"><h3>پروندهٔ کارشناس دیگر</h3><p className="bws-mut">{c.customer.name}{c.customer.expert ? ` · کارشناس: ${c.customer.expert}` : ''}</p></section></aside>;
  return <aside className={only ? 'bws-ctx tab' : 'pane cp bws-ctx'} aria-label="زمینه‌ی مشتری" data-testid="bws-ctx">
    {!only ? <h2 className="bws-h2">زمینهٔ مشتری</h2> : <div className="bws-tabhd"><b>{c.customer.name}</b><span>#{fd(c.customer.id)}</span>{c.customer.expert ? <><Sep /><span>{c.customer.expert}</span></> : null}</div>}
    {!only || only === 'file' ? <><FileBlock c={c} />{only ? <CasesBlock c={c} /> : null}</> : null}
    {!only || only === 'credit' ? <CreditBlock c={c} toast={toast} /> : null}
    {!only ? <CasesBlock c={c} /> : null}
    {!only || only === 'calls' ? <CallsBlock c={c} /> : null}
    {!only || only === 'file' ? <AssetsBlock a={data.assets} /> : null}
  </aside>;
}
