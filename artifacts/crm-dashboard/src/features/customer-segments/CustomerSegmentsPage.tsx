/** t878 «گزارش مشتریان»: 4-step Persian wizard. flag.customer_segments_v1 off → «فعال نیست». */
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'wouter';
import { Check, Lock, Trash2 } from 'lucide-react';
import { faDigits } from '@/lib/credit-grade';
import { gregorianToJalaliValue, jalaliValueToGregorian } from '@/lib/jalali';
import {
  downloadExport, fetchMeta, fetchPreview, fetchValues, useSegmentsMe,
  type Condition, type FieldCat, type FieldValues, type MatchMode, type Meta, type Preview, type PublicRow, type SegmentQuery, type ValueOpt,
} from './api';
import './customer-segments.css';

const STEPS = [
  { id: 1, title: 'منبع و ستون‌ها', short: 'منبع' },
  { id: 2, title: 'فیلترها', short: 'فیلترها' },
  { id: 3, title: 'پیش‌نمایش', short: 'پیش‌نمایش' },
  { id: 4, title: 'خروجی اکسل', short: 'اکسل' },
] as const;

const OP_LABEL: Record<string, string> = {
  in: 'یکی از این‌ها', eq: 'برابر', contains: 'شامل', range: 'بازه عددی',
  date_range: 'بازه تاریخ', exists: 'پر شده', not_exists: 'خالی است',
};

const FILE_SOURCES = new Set(['dossier', 'customer']);
const CARD_PRIMARY = ['phone', 'job', 'status', 'city'];

/** t963: credit-rank fields get the A1…E3 grid + range instead of a flat chip list. */
const RANK_KEYS = new Set(['creditRankAny', 'creditRank', 'creditRankFile', 'creditRankSite', 'guarantorRank']);
const isRankKey = (k?: string) => !!k && RANK_KEYS.has(k);
const RANK_LETTERS = ['A', 'B', 'C', 'D', 'E'] as const;
const RANK_CODES = RANK_LETTERS.flatMap((l) => [1, 2, 3].map((n) => `${l}${n}`));
const RANK_FA: Record<string, string> = { A: 'الف', B: 'ب', C: 'ج', D: 'د', E: 'ه' };
const rankFa = (code: string) => `رتبه ${RANK_FA[code[0]] ?? code[0]}${code[1] ? faDigits(code[1]) : ''}`;
/** Fields offered first in step 2, before the search box. */
const POPULAR = ['creditRankAny', 'job', 'city', 'ownerId', 'status', 'bouncedAny', 'ssoRetiree', 'amountRange'];
const MATCH_TEXT: Record<MatchMode, string> = { all: 'همه‌ی شرط‌ها (و)', any: 'حداقل یکی از شرط‌ها (یا)' };

const defaultOps = (f: FieldCat) => (f.ops.includes('in') ? 'in' : f.ops[0]);
const isPii = (f: FieldCat) => f.sensitive === 'phone' || f.sensitive === 'national';
const uiText = (v: string) => faDigits(v);
/** Count label: Persian digits + thousands separator «٬». Not for ids. */
export function faCount(n: string | number): string {
  const digits = String(n).replace(/[^\d]/g, '');
  if (!digits) return '';
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, '٬');
  return faDigits(grouped);
}

export default function CustomerSegmentsPage() {
  const me = useSegmentsMe(true).data;
  useEffect(() => {
    document.documentElement.classList.add('cses-page');
    return () => { document.documentElement.classList.remove('cses-page'); };
  }, []);
  if (!me) {
    return <div className="cses" dir="rtl" data-testid="page-customer-segments-loading"><p>در حال بارگذاری…</p></div>;
  }
  if (me && !me.enabled) {
    return (
      <div className="cses cses-off" dir="rtl" data-testid="cses-flag-off">
        <div className="cses-card">
          <h1>گزارش مشتریان فعال نیست</h1>
          <p>این گزارش هنوز فعال نیست.</p>
        </div>
      </div>
    );
  }
  if (me && !me.canView) {
    return (
      <div className="cses cses-off" dir="rtl" data-testid="cses-no-access">
        <h1>دسترسی ندارید</h1>
        <p>این گزارش فقط برای مدیر، مدیر فروش و کارشناس است.</p>
      </div>
    );
  }
  return <Wizard ready={Boolean(me?.canView)} scope={me?.scope === 'own' ? 'own' : 'all'} />;
}

function Wizard({ ready, scope }: { ready: boolean; scope: 'all' | 'own' }) {
  const [step, setStep] = useState(1);
  const [maxStep, setMaxStep] = useState(1);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [err, setErr] = useState('');
  const [source, setSource] = useState<SegmentQuery['source']>('both');
  const [includeUnlinked, setIncludeUnlinked] = useState(true);
  const [columns, setColumns] = useState<string[]>([]);
  const [openGroups, setOpenGroups] = useState<string[]>(['profile', 'job']);
  const [conditions, setConditions] = useState<Condition[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loading, setLoading] = useState(false);
  const [includePhones, setIncludePhones] = useState(false);
  const [exported, setExported] = useState(false);
  const [valueStats, setValueStats] = useState<FieldValues[] | null>(null);
  const [match, setMatch] = useState<MatchMode>('all');

  useEffect(() => {
    if (!ready) return;
    let cancel = false;
    fetchMeta().then((m) => {
      if (cancel) return;
      setMeta(m);
      setColumns(m.fields.filter((f) => f.defaultColumn && !isPii(f)).map((f) => f.key));
    }).catch((e) => { if (!cancel) setErr(e instanceof Error ? e.message : 'خطا'); });
    return () => { cancel = true; };
  }, [ready]);

  useEffect(() => {
    if (!ready || !meta) return;
    let cancel = false;
    fetchValues({ source, includeUnlinkedLeads: scope === 'all' && includeUnlinked }).then((r) => {
      if (!cancel) setValueStats(r.fields);
    }).catch((e) => { if (!cancel) setErr(e instanceof Error ? e.message : 'خطا'); });
    return () => { cancel = true; };
  }, [ready, meta, source, includeUnlinked, scope]);

  const fields = meta?.fields ?? [];
  const byKey = useMemo(() => new Map(fields.map((f) => [f.key, f])), [fields]);
  const query = useMemo<SegmentQuery>(() => ({
    source, includeUnlinkedLeads: scope === 'all' && includeUnlinked, conditions: conditions.filter((c) => byKey.has(c.field)), match, columns,
  }), [source, includeUnlinked, conditions, match, columns, byKey, scope]);

  const go = (n: number) => { setStep(n); setMaxStep((m) => Math.max(m, n)); setErr(''); };

  const runPreview = async (page = 1) => {
    setLoading(true); setErr('');
    try {
      const p = await fetchPreview(query, page, 20);
      setPreview(p);
      go(3);
    } catch (e) { setErr(e instanceof Error ? e.message : 'خطا'); }
    finally { setLoading(false); }
  };

  const doExport = async () => {
    setLoading(true); setErr('');
    try {
      await downloadExport(query, includePhones);
      setExported(true);
    } catch (e) { setErr(e instanceof Error ? e.message : 'خطا'); }
    finally { setLoading(false); }
  };

  const exportColCount = columns.filter((k) => k !== 'phone' && k !== 'nationalCode').length + (includePhones ? 2 : 0);

  return (
    <div className="cses" dir="rtl" data-testid="page-customer-segments">
      <header className="cses-h">
        <p className="cses-lead">{scope === 'own' ? 'فیلتر روی مقدار فیلد است؛ فقط مشتری‌های خودتان.' : 'فیلتر روی مقدار فیلد است؛ شرط‌ها را با «و» یا «یا» ترکیب کنید.'}</p>
      </header>
      <p className="cses-step-now">مرحله {faDigits(step)} از {faDigits(4)}</p>
      <ol className="cses-steps">
        {STEPS.map((s) => {
          const cls = step === s.id ? 'on' : s.id < maxStep ? 'done' : 'todo';
          return (
            <li key={s.id}>
              <button type="button" className={cls} onClick={() => s.id <= maxStep && go(s.id)} disabled={s.id > maxStep} aria-label={`مرحله ${faDigits(s.id)} از ${faDigits(4)}: ${s.title}`}>
                <span className="n">
                  {s.id < maxStep ? <Check className="tick" aria-hidden="true" /> : null}
                  {faDigits(s.id)}
                </span>
                <span className="t">{s.short}</span>
              </button>
            </li>
          );
        })}
      </ol>
      {err ? <div className="cses-err" role="alert">{err}</div> : null}
      {step === 1 && meta ? (
        <section className="cses-card" data-testid="cses-step-panel">
          <div className="cses-sec">
            <h2>از کجا جستجو شود؟</h2>
            <div className="cses-radios">
              <label className="cses-opt"><input type="radio" name="src" checked={source === 'both'} onChange={() => setSource('both')} /><span><b>همه منابع</b><span>پرونده مشتری و فرم‌های سایت با هم. اگر هر دو جا مقدار باشد، مقدار پرونده مقدم است.</span></span></label>
              <label className="cses-opt"><input type="radio" name="src" checked={source === 'file'} onChange={() => setSource('file')} /><span><b>فقط پرونده مشتری</b><span>شغل، چک برگشتی، معرفی و بقیه از پرونده، تماس اول و فرم مشاوره.</span></span></label>
              <label className="cses-opt"><input type="radio" name="src" checked={source === 'site'} onChange={() => setSource('site')} /><span><b>فقط فرم‌های سایت</b><span>فقط مشتری‌هایی که فرم ثبت درخواست یا سرنخ سایت دارند.</span></span></label>
            </div>
            <label className="cses-opt">
              <input type="checkbox" checked={scope === 'all' && includeUnlinked} onChange={(e) => setIncludeUnlinked(e.target.checked)} disabled={scope === 'own'} />
              <span><b>سرنخ‌های سایت بدون پرونده هم بیاید</b><span>{scope === 'own' ? 'سرنخ بدون پرونده مالک ندارد؛ در فهرست کارشناس نمی‌آید.' : 'درخواست تماس‌هایی که هنوز به مشتری وصل نشده‌اند. به‌طور پیش‌فرض روشن است.'}</span></span>
            </label>
          </div>
          <div className="cses-sec">
            <h2>کدام ستون‌ها در جدول و اکسل باشد؟</h2>
            <p className="cses-hint">چند فیلد در هر گروه. شماره تماس در پیش‌نمایش همیشه پوشیده است؛ بودن شماره و کد ملی در اکسل در مرحلهٔ ۴ تعیین می‌شود.</p>
            <div className="cses-cols">
              {meta.groups.map((g) => {
                const groupFields = fields.filter((f) => f.group === g.id);
                const choosable = groupFields.filter((f) => !isPii(f));
                const selected = choosable.filter((f) => columns.includes(f.key)).length;
                const open = openGroups.includes(g.id);
                return (
                  <div className="cses-g" key={g.id}>
                    <button type="button" className="cses-g-toggle" aria-expanded={open} onClick={() => setOpenGroups((cur) => cur.includes(g.id) ? cur.filter((x) => x !== g.id) : [...cur, g.id])}>
                      <h3>{g.label}</h3>
                      <span className="cses-g-count">{faDigits(selected)} از {faDigits(choosable.length)}</span>
                    </button>
                    {open ? (
                      <div className="cses-g-body">
                        {groupFields.map((f) => isPii(f) ? (
                          <div className="cses-locked" key={f.key}>
                            <Lock className="lock" aria-hidden="true" />
                            <span>{f.label}</span>
                            <span className="why">در مرحلهٔ ۴ تعیین می‌شود</span>
                          </div>
                        ) : (
                          <label key={f.key}>
                            <input type="checkbox" checked={columns.includes(f.key)} onChange={(e) => setColumns((c) => e.target.checked ? [...c, f.key] : c.filter((x) => x !== f.key))} />
                            {f.label}
                          </label>
                        ))}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>
          <div className="cses-actions">
            <button type="button" className="cses-btn primary" onClick={() => go(2)} disabled={!columns.length}>ادامه: فیلترها</button>
          </div>
        </section>
      ) : null}
      {step === 2 && meta ? (
        <FiltersStep
          fields={fields}
          valueStats={valueStats}
          conditions={conditions}
          setConditions={setConditions}
          columns={columns}
          match={match}
          setMatch={setMatch}
          onBack={() => go(1)}
          onNext={() => runPreview(1)}
          loading={loading}
        />
      ) : null}
      {step === 3 ? (
        <section className="cses-card" data-testid="cses-step3">
          {loading && !preview ? <p className="cses-hint">در حال شمارش…</p> : null}
          {preview && preview.total === 0 ? (
            <p className="cses-empty" data-testid="cses-empty">موردی با این فیلتر پیدا نشد.</p>
          ) : null}
          {preview && preview.total > 0 ? (
            <>
              <p className="cses-count"><span>{faCount(preview.total)}</span> مورد پیدا شد</p>
              {conditions.length >= 2 ? <p className="cses-hint cses-match-note" data-testid="cses-match-note">ترکیب شرط‌ها: {MATCH_TEXT[match]}</p> : null}
              <SourceLegend rows={preview.rows} />
              <div className="cses-cards" data-testid="cses-preview-cards">
                {preview.rows.map((row) => (
                  <CustomerCard key={row.leadKey} row={row} columns={preview.columns} byKey={byKey} />
                ))}
              </div>
              <p className="cses-table-hint">برای دیدن بقیه ستون‌ها از نوار پایین جدول استفاده کنید.</p>
              <div className="cses-table-fade">
              <div className="cses-tablewrap" data-testid="cses-preview-table">
                <table className="cses-table">
                  <thead>
                    <tr>{preview.columns.map((k) => <th key={k} className={k === 'name' ? 'sticky' : undefined}>{byKey.get(k)?.label ?? k}</th>)}</tr>
                  </thead>
                  <tbody>
                    {preview.rows.map((row) => (
                      <tr key={row.leadKey}>
                        {preview.columns.map((k) => (
                          <td key={k} className={k === 'name' ? 'sticky' : undefined}>
                            {k === 'name' && row.customerId ? <Link href={`/customers/${row.customerId}`}>{uiText(row.values[k] || '—')}</Link> : uiText(row.values[k] || '—')}
                            {row.sources[k] && !FILE_SOURCES.has(row.sources[k]) ? (
                              <i className={`cses-src-dot ${row.sources[k]}`} title={row.sourceLabels[k]} aria-label={row.sourceLabels[k]} />
                            ) : null}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              </div>
              <div className="cses-pager">
                <button type="button" className="cses-btn ghost" disabled={preview.page <= 1 || loading} onClick={() => runPreview(preview.page - 1)}>صفحه قبل</button>
                <span>صفحه {faDigits(preview.page)} از {faDigits(Math.max(1, Math.ceil(preview.total / preview.pageSize)))}</span>
                <button type="button" className="cses-btn ghost" disabled={preview.page * preview.pageSize >= preview.total || loading} onClick={() => runPreview(preview.page + 1)}>صفحه بعد</button>
              </div>
            </>
          ) : null}
          <div className="cses-actions">
            <button type="button" className="cses-btn ghost" onClick={() => go(2)}>بازگشت</button>
            <button type="button" className="cses-btn primary" onClick={() => go(4)} disabled={!preview || preview.total === 0}>ادامه: خروجی اکسل</button>
          </div>
        </section>
      ) : null}
      {step === 4 ? (
        <section className="cses-card" data-testid="cses-step4">
          <div className="cses-sec">
            <h2>خروجی اکسل</h2>
            {preview ? <p className="cses-count"><span>{faCount(preview.total)}</span> ردیف با {faCount(exportColCount)} ستون</p> : <p className="cses-hint">ابتدا پیش‌نمایش را ببینید.</p>}
            {conditions.length >= 2 ? <p className="cses-hint" data-testid="cses-match-note-x">اکسل با همین شرط‌ها و همین ترکیب ساخته می‌شود: {MATCH_TEXT[match]}.</p> : null}
            <p className="cses-hint">این کار در گزارش ممیزی ثبت می‌شود.</p>
            <label className="cses-opt">
              <input type="checkbox" checked={includePhones} onChange={(e) => setIncludePhones(e.target.checked)} />
              <span><b>شماره تماس و کد ملی هم در فایل باشد</b><span>ثبت در ممیزی</span></span>
            </label>
            {includePhones ? <p className="cses-warn" role="status" data-testid="cses-pii-warn">در فایل، شماره تماس و کد ملی کامل نوشته می‌شود.</p> : null}
            {exported ? <p className="cses-hint">فایل دانلود شد. اگر مرورگر جلوی دانلود را گرفت، اجازه بدهید و دوباره بزنید.</p> : null}
          </div>
          <div className="cses-actions">
            <button type="button" className="cses-btn ghost" onClick={() => go(3)}>بازگشت</button>
            <button type="button" className="cses-btn primary" onClick={doExport} disabled={loading || !preview}>دانلود فایل اکسل</button>
          </div>
        </section>
      ) : null}
    </div>
  );
}

function SourceLegend({ rows }: { rows: PublicRow[] }) {
  const used = new Set<string>();
  const labels: Record<string, string> = {};
  for (const row of rows) {
    for (const [k, src] of Object.entries(row.sources || {})) {
      if (!FILE_SOURCES.has(src)) { used.add(src); labels[src] = row.sourceLabels[k] || src; }
    }
  }
  if (!used.size) return null;
  return (
    <p className="cses-legend">
      منبع، وقتی با پرونده فرق دارد:
      {[...used].map((s) => (
        <span key={s}><i className={`cses-src-dot ${s}`} />{labels[s]}</span>
      ))}
    </p>
  );
}

function CustomerCard({ row, columns, byKey }: { row: PublicRow; columns: string[]; byKey: Map<string, FieldCat> }) {
  const [open, setOpen] = useState(false);
  const name = uiText(row.values.name || '—');
  const id = row.values.customerId ? uiText(row.values.customerId) : '';
  const rest = columns.filter((k) => k !== 'name' && k !== 'customerId');
  const primary = rest.filter((k) => CARD_PRIMARY.includes(k)).slice(0, 2);
  const extra = rest.filter((k) => !primary.includes(k));
  const shown = open ? [...primary, ...extra] : primary;
  return (
    <article className="cses-pcard">
      <div className="hd">
        {row.customerId ? <Link className="nm" href={`/customers/${row.customerId}`}>{name}</Link> : <span className="nm">{name}</span>}
        {id ? <span className="id">شناسه {id}</span> : null}
      </div>
      <dl className="kv">
        {shown.map((k) => (
          <div key={k}>
            <dt>{k === 'phone' ? 'تلفن پوشیده' : (byKey.get(k)?.label ?? k)}</dt>
            <dd>
              {uiText(row.values[k] || '—')}
              {row.sources[k] && !FILE_SOURCES.has(row.sources[k]) ? <i className={`cses-src-dot ${row.sources[k]}`} title={row.sourceLabels[k]} /> : null}
            </dd>
          </div>
        ))}
      </dl>
      {extra.length ? (
        <button type="button" className="cses-more" data-testid="cses-card-more" onClick={() => setOpen((v) => !v)}>
          {open ? 'نمایش کمتر' : 'نمایش بیشتر'}
        </button>
      ) : null}
    </article>
  );
}

function JalaliRange({ min, max, onChange }: { min?: string; max?: string; onChange: (min: string, max: string) => void }) {
  const show = (g?: string) => {
    const j = gregorianToJalaliValue(g || '');
    return j ? faDigits(j) : '';
  };
  const [from, setFrom] = useState(show(typeof min === 'string' ? min : ''));
  const [to, setTo] = useState(show(typeof max === 'string' ? max : ''));
  const commit = (a: string, b: string) => {
    setFrom(a); setTo(b);
    onChange(jalaliValueToGregorian(a) || '', jalaliValueToGregorian(b) || '');
  };
  return (
    <div className="row">
      <label className="cses-date">
        <span>از</span>
        <input type="text" inputMode="numeric" placeholder="۱۴۰۱/۰۱/۰۱" aria-label="از تاریخ جلالی" value={from} onChange={(e) => commit(e.target.value, to)} />
      </label>
      <label className="cses-date">
        <span>تا</span>
        <input type="text" inputMode="numeric" placeholder="۱۴۰۵/۱۲/۲۹" aria-label="تا تاریخ جلالی" value={to} onChange={(e) => commit(from, e.target.value)} />
      </label>
    </div>
  );
}

function FiltersStep({ fields, valueStats, conditions, setConditions, columns, match, setMatch, onBack, onNext, loading }: {
  fields: FieldCat[]; valueStats: FieldValues[] | null; conditions: Condition[]; setConditions: (c: Condition[]) => void;
  columns: string[]; match: MatchMode; setMatch: (m: MatchMode) => void;
  onBack: () => void; onNext: () => void; loading: boolean;
}) {
  const [q, setQ] = useState('');
  const found = fields.filter((f) => !isPii(f) && (!q.trim() || f.label.includes(q.trim()) || f.key.includes(q.trim())));
  const statsBy = useMemo(() => new Map((valueStats ?? []).map((s) => [s.field, s])), [valueStats]);
  const add = (field: string) => {
    const f = fields.find((x) => x.key === field);
    if (!f || isPii(f)) return;
    const stats = statsBy.get(field);
    const op = (f.type === 'number' || f.type === 'date')
      ? (f.type === 'date' ? 'date_range' : 'range')
      : (f.type === 'text' && !(stats && stats.values.length) && f.ops.includes('contains') ? 'contains' : defaultOps(f));
    setConditions([...conditions, { field, op, values: [] }]);
    setQ('');
  };
  /** Step-1 columns first (so a rank column picked there is offered here), then the usual suspects. */
  const suggested = useMemo(() => {
    const have = new Set(conditions.map((c) => c.field));
    const keys = [POPULAR[0], ...columns.filter((k) => k !== 'name' && k !== 'customerId'), ...POPULAR];
    const seen = new Set<string>();
    const out: FieldCat[] = [];
    for (const k of keys) {
      const f = fields.find((x) => x.key === k);
      if (!f || isPii(f) || seen.has(k) || have.has(k)) continue;
      seen.add(k); out.push(f);
    }
    return out.slice(0, 10);
  }, [fields, columns, conditions]);
  const quick = [
    { field: 'job', values: ['retired'], label: 'بازنشسته' },
    { field: 'ssoRetiree', values: ['self'], label: 'خودش بازنشسته تأمین اجتماعی' },
    { field: 'ssoRetiree', values: ['family'], label: 'بازنشسته در خانواده' },
    { field: 'canReferRetiree', values: ['yes'], label: 'می‌تواند بازنشسته معرفی کند' },
    { field: 'bouncedAny', values: ['yes'], label: 'چک برگشتی در هر منبع' },
    { field: 'hasSiteApply', values: ['yes'], label: 'فرم سایت دارد' },
  ];
  return (
    <section className="cses-card" data-testid="cses-step2">
      <div className="cses-sec">
        <h2>فیلترها</h2>
        <p className="cses-hint">مقدار را برگزینید؛ چند مقدار با «یا».</p>
        <div className="cses-quick">
          {quick.map((x) => (
            <button type="button" key={x.label} onClick={() => setConditions([...conditions, { field: x.field, op: 'in', values: x.values }])}>{x.label}</button>
          ))}
        </div>
        {conditions.length >= 2 ? (
          <div className="cses-match" data-testid="cses-match">
            <p className="cses-match-t">شرط‌ها چگونه ترکیب شوند؟</p>
            <div className="cses-seg" role="radiogroup" aria-label="ترکیب شرط‌ها">
              <button type="button" role="radio" aria-checked={match === 'all'} className={match === 'all' ? 'on' : ''} data-testid="cses-match-all" onClick={() => setMatch('all')}>
                <b>همه‌ی شرط‌ها</b><span>و</span>
              </button>
              <button type="button" role="radio" aria-checked={match === 'any'} className={match === 'any' ? 'on' : ''} data-testid="cses-match-any" onClick={() => setMatch('any')}>
                <b>حداقل یکی از شرط‌ها</b><span>یا</span>
              </button>
            </div>
            <p className="cses-hint">{match === 'all' ? 'مشتری باید همهٔ شرط‌ها را داشته باشد.' : 'مشتری با داشتن هر یک از شرط‌ها می‌آید.'}</p>
          </div>
        ) : null}
        <div className="cses-filters">
          {conditions.map((c, i) => {
            const f = fields.find((x) => x.key === c.field);
            const stats = statsBy.get(c.field);
            return (
              <div key={`${c.field}-${i}`} className="cses-fwrap">
                {i > 0 ? <div className="cses-join" aria-hidden="true" data-testid="cses-join"><span>{match === 'all' ? 'و' : 'یا'}</span></div> : null}
                <ConditionRow
                  field={f}
                  stats={stats}
                  condition={c}
                  fields={fields}
                  onChange={(next) => { const list = conditions.slice(); list[i] = next; setConditions(list); }}
                  onRemove={() => setConditions(conditions.filter((_, j) => j !== i))}
                />
              </div>
            );
          })}
        </div>
        <input className="cses-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="جستجوی فیلد برای افزودن…" />
        {!q.trim() ? <p className="cses-hint">افزودن فیلتر: از ستون‌هایی که برگزیدید، یا جستجو کنید.</p> : null}
        <div className="cses-chips" data-testid="cses-add-chips">
          {(q.trim() ? found.slice(0, 30) : suggested).map((f) => (
            <button type="button" key={f.key} className={`cses-chip${isRankKey(f.key) ? ' hot' : ''}`} data-testid="cses-add-chip" onClick={() => add(f.key)}>+ {f.label}</button>
          ))}
        </div>
      </div>
      <div className="cses-actions">
        <button type="button" className="cses-btn ghost" onClick={onBack}>بازگشت</button>
        <button type="button" className="cses-btn primary" onClick={onNext} disabled={loading}>{loading ? 'در حال شمارش…' : 'پیش‌نمایش'}</button>
      </div>
    </section>
  );
}

function ConditionRow({ field, stats, condition, fields, onChange, onRemove }: {
  field: FieldCat | undefined; stats: FieldValues | undefined; condition: Condition;
  fields: FieldCat[]; onChange: (c: Condition) => void; onRemove: () => void;
}) {
  const [q, setQ] = useState('');
  const c = condition;
  const f = field;
  const isValueOp = c.op === 'in' || c.op === 'eq' || c.op === 'contains';
  const noValueYet = isValueOp && !(c.values && c.values.length);
  const values = stats?.values ?? f?.options ?? [];
  const shown = q.trim()
    ? values.filter((o) => o.label.includes(q.trim()) || o.value.includes(q.trim()))
    : values;
  const pickValue = (value: string) => {
    const on = (c.values ?? []).includes(value);
    const next = on ? (c.values ?? []).filter((v) => v !== value) : [...(c.values ?? []), value];
    onChange({ ...c, op: 'in', values: next, min: undefined, max: undefined });
  };
  const setPresence = (op: 'exists' | 'not_exists') => {
    onChange({ ...c, op: c.op === op ? 'in' : op, values: [], min: undefined, max: undefined });
  };
  const isRank = isRankKey(f?.key);
  const showChips = !isRank && (f?.type !== 'number' && f?.type !== 'date' && f?.key !== 'name' && f?.key !== 'customerId');
  const showContains = f?.type === 'text' && (f.key === 'name' || (showChips && q.trim() && !shown.length));
  const showRange = f?.type === 'number' || f?.key === 'customerId';
  const showDate = f?.type === 'date';
  return (
    <div className="cses-f" data-testid="cses-condition">
      <div className="row">
        <select value={c.field} title={f?.label} onChange={(e) => {
          const nf = fields.find((x) => x.key === e.target.value);
          const typ = nf?.type;
          const op = typ === 'date' ? 'date_range' : typ === 'number' || nf?.key === 'customerId' ? 'range' : defaultOps(nf ?? f ?? { ops: ['in'] } as FieldCat);
          onChange({ field: e.target.value, op, values: [] });
        }}>
          {fields.filter((x) => !isPii(x)).map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
        </select>
        <button type="button" className="cses-btn ghost cses-del" aria-label="حذف" title="حذف" onClick={onRemove}><Trash2 size={18} aria-hidden="true" /></button>
      </div>
      {f?.description ? <p className="cses-hint">{f.description}</p> : null}
      {isRank ? <RankPicker condition={c} options={values} onChange={onChange} /> : null}
      {showChips ? (
        <>
          {values.length > 12 ? (
            <input className="cses-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="جستجوی مقدار…" aria-label="جستجوی مقدار" />
          ) : null}
          <div className="cses-chips" data-testid="cses-value-chips">
            {shown.map((o) => {
              const on = (c.values ?? []).includes(o.value) && c.op === 'in';
              const count = 'count' in o && typeof o.count === 'number' ? o.count : undefined;
              return (
                <button type="button" key={o.value} className={`cses-chip${on ? ' on' : ''}`} data-testid="cses-value-chip" onClick={() => pickValue(o.value)}>
                  <span className="cses-chip-label">{o.label}</span>
                  {count != null ? <span className="cses-n">{faCount(count)}</span> : null}
                </button>
              );
            })}
            {!shown.length && values.length ? <p className="cses-hint">مقداری با این جستجو پیدا نشد.</p> : null}
            {!values.length && !valueStatsLoading(stats) ? <p className="cses-hint">برای این فیلد هنوز مقدار ذخیره‌شده‌ای نیست؛ می‌توانید «پر شده» یا «خالی است» را بزنید.</p> : null}
          </div>
        </>
      ) : null}
      {showContains ? (
        <input type="text" value={c.op === 'contains' || c.op === 'eq' ? (c.values?.[0] ?? '') : ''} placeholder="شامل این نوشته…" onChange={(e) => onChange({ ...c, op: 'contains', values: [e.target.value] })} />
      ) : null}
      {showRange ? (
        <div className="cses-range">
          <input type="number" placeholder={stats?.min != null ? `از ${faCount(stats.min)}` : 'از'} value={c.min ?? ''} onChange={(e) => onChange({ ...c, op: 'range', min: e.target.value, values: [] })} />
          <input type="number" placeholder={stats?.max != null ? `تا ${faCount(stats.max)}` : 'تا'} value={c.max ?? ''} onChange={(e) => onChange({ ...c, op: 'range', max: e.target.value, values: [] })} />
        </div>
      ) : null}
      {showDate ? (
        <JalaliRange
          min={c.min != null ? String(c.min) : ''}
          max={c.max != null ? String(c.max) : ''}
          onChange={(min, max) => onChange({ ...c, op: 'date_range', min, max, values: [] })}
        />
      ) : null}
      <div className="cses-chips cses-presence">
        <button type="button" className={`cses-chip${c.op === 'exists' ? ' on' : ''}`} onClick={() => setPresence('exists')}>
          <span className="cses-chip-label">پر شده</span>
          {stats ? <span className="cses-n">{faCount(stats.filled)}</span> : null}
        </button>
        <button type="button" className={`cses-chip${c.op === 'not_exists' ? ' on' : ''}`} onClick={() => setPresence('not_exists')}>
          <span className="cses-chip-label">خالی است</span>
          {stats ? <span className="cses-n">{faCount(stats.empty)}</span> : null}
        </button>
      </div>
      {noValueYet ? <p className="cses-needval">چیزی انتخاب نشده؛ همه می‌آیند</p> : null}
      {isRank && c.op === 'range' && !c.min && !c.max ? <p className="cses-needval">بازه‌ای انتخاب نشده؛ همه می‌آیند</p> : null}
    </div>
  );
}

/** t963: A1…E3 grid (letter row selects A1–A3 + legacy «A»), or an «از … تا …» range. Best grade is A1. */
function RankPicker({ condition: c, options, onChange }: { condition: Condition; options: Array<ValueOpt | { value: string; label: string }>; onChange: (c: Condition) => void }) {
  const mode: 'pick' | 'range' = c.op === 'range' ? 'range' : 'pick';
  const countOf = (v: string): number | undefined => {
    const o = options.find((x) => x.value === v);
    return o && 'count' in o && typeof o.count === 'number' ? o.count : undefined;
  };
  const picked = new Set(c.op === 'in' ? (c.values ?? []) : []);
  const toggle = (v: string) => {
    const next = picked.has(v) ? [...picked].filter((x) => x !== v) : [...picked, v];
    onChange({ ...c, op: 'in', values: next, min: undefined, max: undefined });
  };
  const setMode = (m: 'pick' | 'range') => {
    if (m === mode) return;
    onChange(m === 'range' ? { ...c, op: 'range', values: [], min: '', max: '' } : { ...c, op: 'in', values: [], min: undefined, max: undefined });
  };
  const from = RANK_CODES.indexOf(String(c.min ?? ''));
  const to = RANK_CODES.indexOf(String(c.max ?? ''));
  const backwards = from >= 0 && to >= 0 && from > to;
  const unknownCount = countOf('unknown');
  const chip = (v: string, letter: boolean) => {
    const n = countOf(v);
    return (
      <button type="button" key={v} className={`cses-chip cses-rk${picked.has(v) ? ' on' : ''}${letter ? ' letter' : ''}${n === 0 ? ' zero' : ''}`}
        aria-pressed={picked.has(v)} title={letter ? `همهٔ ${v}۱ تا ${v}۳ (و ${v} قدیمی)` : rankFa(v)} data-testid="cses-rank-chip" onClick={() => toggle(v)}>
        <bdi dir="ltr" className="cses-rk-code">{v}</bdi>
        {n != null ? <span className="cses-n">{faCount(n)}</span> : null}
      </button>
    );
  };
  return (
    <div className="cses-rank" data-testid="cses-rank-picker">
      <div className="cses-seg cses-seg-sm" role="radiogroup" aria-label="روش انتخاب رتبه">
        <button type="button" role="radio" aria-checked={mode === 'pick'} className={mode === 'pick' ? 'on' : ''} data-testid="cses-rank-mode-pick" onClick={() => setMode('pick')}><b>انتخاب رتبه‌ها</b></button>
        <button type="button" role="radio" aria-checked={mode === 'range'} className={mode === 'range' ? 'on' : ''} data-testid="cses-rank-mode-range" onClick={() => setMode('range')}><b>بازه از … تا …</b></button>
      </div>
      {mode === 'pick' ? (
        <>
          <div className="cses-rkgrid" data-testid="cses-rank-grid">
            {RANK_LETTERS.map((l) => (
              <div className="cses-rkrow" key={l}>
                {chip(l, true)}
                {[1, 2, 3].map((n) => chip(`${l}${n}`, false))}
              </div>
            ))}
          </div>
          {unknownCount ? (
            <button type="button" className={`cses-chip cses-rk-unk${picked.has('unknown') ? ' on' : ''}`} aria-pressed={picked.has('unknown')} data-testid="cses-rank-chip" onClick={() => toggle('unknown')}>
              <span className="cses-chip-label">نامشخص</span><span className="cses-n">{faCount(unknownCount)}</span>
            </button>
          ) : null}
          <p className="cses-hint">A1 بهترین و E3 ضعیف‌ترین است. حرف اول هر ردیف یعنی هر سه زیررتبه.</p>
        </>
      ) : (
        <>
          <div className="cses-rkrange">
            <label><span>از رتبه</span>
              <select aria-label="از رتبه" data-testid="cses-rank-from" value={String(c.min ?? '')} onChange={(e) => onChange({ ...c, op: 'range', values: [], min: e.target.value, max: c.max ?? '' })}>
                <option value="">بهترین (A1)</option>
                {RANK_CODES.map((v) => <option key={v} value={v}>{v} — {rankFa(v)}</option>)}
              </select>
            </label>
            <label><span>تا رتبه</span>
              <select aria-label="تا رتبه" data-testid="cses-rank-to" value={String(c.max ?? '')} onChange={(e) => onChange({ ...c, op: 'range', values: [], min: c.min ?? '', max: e.target.value })}>
                <option value="">ضعیف‌ترین (E3)</option>
                {RANK_CODES.map((v) => <option key={v} value={v}>{v} — {rankFa(v)}</option>)}
              </select>
            </label>
          </div>
          {backwards ? <p className="cses-warn" role="status">«از» باید بهتر از «تا» باشد؛ جابه‌جا کنید.</p> : <p className="cses-hint">رتبهٔ قدیمی فقط‌حرفی (مثل C) هم می‌آید اگر زیررتبه‌هایش در بازه بگنجد.</p>}
        </>
      )}
    </div>
  );
}

function valueStatsLoading(stats: FieldValues | undefined) {
  return !stats;
}
