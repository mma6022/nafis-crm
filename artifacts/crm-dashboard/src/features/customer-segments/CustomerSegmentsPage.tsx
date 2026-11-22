/** t878 «گزارش مشتریان»: 4-step Persian wizard. flag.customer_segments_v1 off → «فعال نیست». */
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'wouter';
import { faDigits } from '@/lib/credit-grade';
import {
  downloadExport, fetchMeta, fetchPreview, useSegmentsMe,
  type Condition, type FieldCat, type Meta, type Preview, type SegmentQuery,
} from './api';
import './customer-segments.css';

const STEPS = [
  { id: 1, title: 'منبع و ستون‌ها' },
  { id: 2, title: 'فیلترها' },
  { id: 3, title: 'پیش‌نمایش' },
  { id: 4, title: 'خروجی اکسل' },
] as const;

const OP_LABEL: Record<string, string> = {
  in: 'یکی از این‌ها', eq: 'برابر', contains: 'شامل', range: 'بازه عددی',
  date_range: 'بازه تاریخ', exists: 'پر شده', not_exists: 'خالی است',
};

const defaultOps = (f: FieldCat) => (f.ops.includes('in') ? 'in' : f.ops[0]);

export default function CustomerSegmentsPage() {
  const me = useSegmentsMe(true).data;
  if (!me) {
    return <div className="cses" dir="rtl" data-testid="page-customer-segments-loading"><p>در حال بارگذاری…</p></div>;
  }
  if (me && !me.enabled) {
    return (
      <div className="cses cses-off" dir="rtl">
        <h1>گزارش مشتریان فعال نیست</h1>
        <p>این بخش پشت سوییچ خاموش است و هنوز منتشر نشده.</p>
      </div>
    );
  }
  if (me && !me.canView) {
    return (
      <div className="cses cses-off" dir="rtl">
        <h1>دسترسی ندارید</h1>
        <p>این گزارش فقط برای مدیر و مدیر فروش است.</p>
      </div>
    );
  }
  return <Wizard ready={Boolean(me?.canView)} />;
}

function Wizard({ ready }: { ready: boolean }) {
  const [step, setStep] = useState(1);
  const [maxStep, setMaxStep] = useState(1);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [err, setErr] = useState('');
  const [source, setSource] = useState<SegmentQuery['source']>('both');
  const [includeUnlinked, setIncludeUnlinked] = useState(false);
  const [columns, setColumns] = useState<string[]>([]);
  const [conditions, setConditions] = useState<Condition[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loading, setLoading] = useState(false);
  const [includePhones, setIncludePhones] = useState(true);
  const [exported, setExported] = useState(false);

  useEffect(() => {
    if (!ready) return;
    let cancel = false;
    fetchMeta().then((m) => {
      if (cancel) return;
      setMeta(m);
      setColumns(m.fields.filter((f) => f.defaultColumn && f.sensitive !== 'national').map((f) => f.key));
    }).catch((e) => { if (!cancel) setErr(e instanceof Error ? e.message : 'خطا'); });
    return () => { cancel = true; };
  }, [ready]);

  const fields = meta?.fields ?? [];
  const byKey = useMemo(() => new Map(fields.map((f) => [f.key, f])), [fields]);
  const query = useMemo<SegmentQuery>(() => ({
    source, includeUnlinkedLeads: includeUnlinked, conditions: conditions.filter((c) => byKey.has(c.field)), columns,
  }), [source, includeUnlinked, conditions, columns, byKey]);

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

  return (
    <div className="cses" dir="rtl" data-testid="page-customer-segments">
      <header className="cses-h">
        <h1>گزارش مشتریان</h1>
        <p>مشتری‌ها را بر اساس دادهٔ پرونده و فرم‌های سایت جدا کنید و خروجی اکسل بگیرید. فیلترها با «و» ترکیب می‌شوند.</p>
      </header>
      <ol className="cses-steps">
        {STEPS.map((s) => (
          <li key={s.id}>
            <button type="button" className={step === s.id ? 'on' : s.id < maxStep ? 'done' : ''} onClick={() => s.id <= maxStep && go(s.id)} disabled={s.id > maxStep}>
              <span className="n">مرحله {faDigits(s.id)} از {faDigits(4)}</span>
              <span className="t">{s.title}</span>
            </button>
          </li>
        ))}
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
              <input type="checkbox" checked={includeUnlinked} onChange={(e) => setIncludeUnlinked(e.target.checked)} />
              <span><b>سرنخ‌های سایت بدون پرونده هم بیاید</b><span>درخواست تماس‌هایی که هنوز به مشتری وصل نشده‌اند.</span></span>
            </label>
          </div>
          <div className="cses-sec">
            <h2>کدام ستون‌ها در جدول و اکسل باشد؟</h2>
            <p className="cses-hint">چند فیلد در هر گروه. شماره تماس در پیش‌نمایش همیشه پوشیده است؛ در خروجی اکسل اختیاری است.</p>
            <div className="cses-cols">
              {meta.groups.map((g) => (
                <div className="cses-g" key={g.id}>
                  <h3>{g.label}</h3>
                  {fields.filter((f) => f.group === g.id).map((f) => (
                    <label key={f.key}>
                      <input type="checkbox" checked={columns.includes(f.key)} onChange={(e) => setColumns((c) => e.target.checked ? [...c, f.key] : c.filter((x) => x !== f.key))} />
                      {f.label}
                    </label>
                  ))}
                </div>
              ))}
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
          conditions={conditions}
          setConditions={setConditions}
          onBack={() => go(1)}
          onNext={() => runPreview(1)}
          loading={loading}
        />
      ) : null}
      {step === 3 ? (
        <section className="cses-card">
          {loading && !preview ? <p className="cses-hint">در حال شمارش…</p> : null}
          {preview ? (
            <>
              <p className="cses-count"><span>{faDigits(preview.total)}</span> مورد پیدا شد</p>
              <div className="cses-tablewrap">
                <table className="cses-table">
                  <thead>
                    <tr>{preview.columns.map((k) => <th key={k}>{byKey.get(k)?.label ?? k}</th>)}</tr>
                  </thead>
                  <tbody>
                    {preview.rows.map((row) => (
                      <tr key={row.leadKey}>
                        {preview.columns.map((k) => (
                          <td key={k}>
                            {k === 'name' && row.customerId ? <Link href={`/customers/${row.customerId}`}>{row.values[k] || '—'}</Link> : (row.values[k] || '—')}
                            {row.sourceLabels[k] ? <span className="cses-src">{row.sourceLabels[k]}</span> : null}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
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
            <button type="button" className="cses-btn primary" onClick={() => go(4)} disabled={!preview}>ادامه: خروجی اکسل</button>
          </div>
        </section>
      ) : null}
      {step === 4 ? (
        <section className="cses-card">
          <div className="cses-sec">
            <h2>خروجی اکسل</h2>
            <p className="cses-hint">
              {preview ? <>{faDigits(preview.total)} ردیف با {faDigits(columns.length)} ستون دانلود می‌شود. این کار در گزارش ممیزی ثبت می‌شود.</> : 'ابتدا پیش‌نمایش را ببینید.'}
            </p>
            <label className="cses-opt">
              <input type="checkbox" checked={includePhones} onChange={(e) => setIncludePhones(e.target.checked)} />
              <span><b>شماره تماس و کد ملی در فایل باشد</b><span>فقط مدیر و مدیر فروش می‌توانند خروجی بگیرند. اگر تیک را بردارید، این ستون‌ها از فایل حذف می‌شوند.</span></span>
            </label>
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

function FiltersStep({ fields, conditions, setConditions, onBack, onNext, loading }: {
  fields: FieldCat[]; conditions: Condition[]; setConditions: (c: Condition[]) => void;
  onBack: () => void; onNext: () => void; loading: boolean;
}) {
  const [q, setQ] = useState('');
  const found = fields.filter((f) => !q.trim() || f.label.includes(q.trim()) || f.key.includes(q.trim()));
  const add = (field: string) => {
    const f = fields.find((x) => x.key === field);
    if (!f) return;
    setConditions([...conditions, { field, op: defaultOps(f), values: [] }]);
  };
  const quick = [
    { field: 'job', values: ['retired'], label: 'بازنشسته' },
    { field: 'canReferRetiree', values: ['yes'], label: 'می‌تواند بازنشسته معرفی کند' },
    { field: 'bouncedAny', values: ['yes'], label: 'چک برگشتی در هر منبع' },
    { field: 'hasSiteApply', values: ['yes'], label: 'فرم سایت دارد' },
  ];
  return (
    <section className="cses-card">
      <div className="cses-sec">
        <h2>فیلترها</h2>
        <p className="cses-hint">همهٔ شرط‌ها با هم اعمال می‌شوند (و). داخل هر شرط، چند گزینه با «یا» هستند. اگر فیلتری نگذارید، همهٔ مشتری‌های همان منبع می‌آیند.</p>
        <div className="cses-quick">
          {quick.map((x) => (
            <button type="button" key={x.label} onClick={() => setConditions([...conditions, { field: x.field, op: 'in', values: x.values }])}>{x.label}</button>
          ))}
        </div>
        <div className="cses-filters">
          {conditions.map((c, i) => {
            const f = fields.find((x) => x.key === c.field);
            return (
              <div className="cses-f" key={`${c.field}-${i}`}>
                <div className="row">
                  <select value={c.field} onChange={(e) => {
                    const nf = fields.find((x) => x.key === e.target.value);
                    const next = conditions.slice();
                    next[i] = { field: e.target.value, op: nf ? defaultOps(nf) : 'in', values: [] };
                    setConditions(next);
                  }}>
                    {fields.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
                  </select>
                  <select value={c.op} onChange={(e) => {
                    const next = conditions.slice(); next[i] = { ...c, op: e.target.value }; setConditions(next);
                  }}>
                    {(f?.ops ?? ['in']).map((op) => <option key={op} value={op}>{OP_LABEL[op] ?? op}</option>)}
                  </select>
                  <button type="button" className="cses-btn ghost" onClick={() => setConditions(conditions.filter((_, j) => j !== i))}>حذف</button>
                </div>
                {f?.description ? <p className="cses-hint">{f.description}</p> : null}
                {c.op === 'in' && f?.options ? (
                  <div className="cses-chips">
                    {f.options.map((o) => {
                      const on = (c.values ?? []).includes(o.value);
                      return (
                        <button type="button" key={o.value} className={`cses-chip${on ? ' on' : ''}`} onClick={() => {
                          const cur = new Set(c.values ?? []);
                          if (on) cur.delete(o.value); else cur.add(o.value);
                          const next = conditions.slice(); next[i] = { ...c, values: [...cur] }; setConditions(next);
                        }}>{o.label}</button>
                      );
                    })}
                  </div>
                ) : null}
                {c.op === 'contains' || c.op === 'eq' ? (
                  <input type="text" value={c.values?.[0] ?? ''} onChange={(e) => {
                    const next = conditions.slice(); next[i] = { ...c, values: [e.target.value] }; setConditions(next);
                  }} placeholder="متن جستجو" />
                ) : null}
                {c.op === 'range' ? (
                  <div className="row">
                    <input type="number" placeholder="از" value={c.min ?? ''} onChange={(e) => { const next = conditions.slice(); next[i] = { ...c, min: e.target.value }; setConditions(next); }} />
                    <input type="number" placeholder="تا" value={c.max ?? ''} onChange={(e) => { const next = conditions.slice(); next[i] = { ...c, max: e.target.value }; setConditions(next); }} />
                  </div>
                ) : null}
                {c.op === 'date_range' ? (
                  <div className="row">
                    <input type="date" value={c.min ?? ''} onChange={(e) => { const next = conditions.slice(); next[i] = { ...c, min: e.target.value }; setConditions(next); }} />
                    <input type="date" value={c.max ?? ''} onChange={(e) => { const next = conditions.slice(); next[i] = { ...c, max: e.target.value }; setConditions(next); }} />
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
        <input className="cses-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="جستجوی فیلد برای افزودن…" />
        <div className="cses-chips">
          {found.slice(0, q.trim() ? 30 : 8).map((f) => (
            <button type="button" key={f.key} className="cses-chip" onClick={() => add(f.key)}>+ {f.label}</button>
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
