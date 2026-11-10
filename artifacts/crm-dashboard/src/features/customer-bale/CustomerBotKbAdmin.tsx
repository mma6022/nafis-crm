/* Armita bale-bot-kb v1.0 — pixel-for-pixel admin (دانش / کلیدها / ربات‌ها).
   Behind flag.customer_bale_admin (default OFF) and server-enforced admin role.
   After save, a key is NEVER kept in state or shown, not even last4. Preview is KB text only. */
import { useEffect, useMemo, useState } from 'react';
import { Link, useSearch } from 'wouter';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import './bale-bot-kb.css';
import { bbFetch, BbError, type BbAdminExpert } from '../bale-bot/api';
import { I, useToast, Confirm } from '../bale-bot/ui';
import { jalaliWeekdayDate } from '../bale-bot/jalali';
import { BotWizard, Saved } from '../bale-bot/BaleBotAdmin';

export type KbRow = {
  id: number; title: string; body: string; active: number | boolean;
  category?: string | null; scope?: string | null; updated_at?: string; updated_by?: number | null;
};
type SecretMeta = { set: boolean; savedAt: string | null; last4?: unknown; model?: string; defaultModel?: string };
type SharedBot = { id: number; name: string; username: string | null; status: string; hasToken: boolean; connectedAt?: string | null };
export type KbAdminPayload = {
  openai: SecretMeta; deepseek: SecretMeta;
  kb: KbRow[]; scopes: string[]; categories: string[]; defaultScope: string;
  sharedBot: SharedBot | null;
};

const SCOPES_FALLBACK = ['همهٔ ربات‌ها', 'فقط ربات نفیس وام', 'ربات‌های کارشناس'];
const CATS_FALLBACK = ['مدارک', 'مراحل پرونده', 'ساعات پاسخگویی', 'شرایط عمومی'];

export function jalaliSaved(iso: string | null | undefined): string {
  return jalaliWeekdayDate(iso);
}

type Tab = 'kb' | 'keys' | 'bots';
function tabFromSearch(s: string): Tab {
  const t = new URLSearchParams(s.startsWith('?') ? s.slice(1) : s).get('tab');
  return t === 'keys' || t === 'bots' ? t : 'kb';
}

const TITLES: Record<Tab, [string, string]> = {
  kb: ['پایگاه دانش ربات', 'پاسخ خودکار فقط از روی مدخل‌های فعال ساخته می‌شود.'],
  keys: ['کلیدهای پاسخ خودکار', 'کلید پس از ذخیره دیده نمی‌شود، حتی به‌صورت ناقص.'],
  bots: ['ربات‌های بله', 'ربات مشترک نفیس وام برای مشتری بدون کارشناس است.'],
};

export function DesignedNoAccess() {
  useEffect(() => { document.title = 'ربات‌های بله | نفیس وام'; }, []);
  return <div className="bbt bk-admin" dir="rtl" data-testid="bale-bot-no-access">
    <main className="pg">
      <div className="bk-na">
        <div className="lk"><I n="lock" /></div>
        <b>این بخش برای مدیر سیستم است</b>
        <p>ویرایش پایگاه دانش و کلیدهای پاسخ خودکار فقط با مدیر سیستم است. گفتگوهای ربات خودتان در «گفتگوهای بله» است.</p>
        <Link className="btn pri" href="/bale-bot"><I n="chat" />گفتگوهای بله‌ی من</Link>
      </div>
    </main>
  </div>;
}

function Tabs({ tab }: { tab: Tab }) {
  const href = (t: Tab) => `/bale-bot/admin?tab=${t}`;
  return <div className="bk-tabs" role="tablist" aria-label="بخش‌های تنظیمات ربات">
    <Link href={href('kb')} aria-current={tab === 'kb' ? 'page' : undefined}>دانش</Link>
    <Link href={href('keys')} aria-current={tab === 'keys' ? 'page' : undefined}>کلیدها</Link>
    <Link href={href('bots')} aria-current={tab === 'bots' ? 'page' : undefined}>ربات‌ها</Link>
  </div>;
}

export default function CustomerBotKbAdmin() {
  const qc = useQueryClient();
  const search = useSearch();
  const tab = tabFromSearch(search);
  const { toast, node } = useToast();
  const q = useQuery<KbAdminPayload>({
    queryKey: ['cb-kb-admin'],
    queryFn: () => bbFetch('/bale-bot/customer-bot/admin'),
  });
  useEffect(() => { document.title = `${TITLES[tab][0]} | نفیس وام`; }, [tab]);

  const d = q.data;
  const [title, subtitle] = TITLES[tab];

  return <div className="bbt bk-admin" dir="rtl" data-testid="bale-bot-kb-admin">
    <main className="pg">
      <div className="bk-wrap">
        <div className="bk-head"><div>
          <h2>{title}</h2>
          <p>{subtitle}</p>
        </div></div>
        <Tabs tab={tab} />
        {q.isLoading ? <span className="bbsk" /> : q.error ? <div className="bk-banner err" role="alert"><I n="alert" /><div><b>بارگذاری انجام نشد</b>پیام سرور: ارتباط برقرار نشد. دوباره امتحان کنید.</div></div>
          : tab === 'kb' ? <KbTab d={d!} toast={toast} reload={() => void qc.invalidateQueries({ queryKey: ['cb-kb-admin'] })} />
          : tab === 'keys' ? <KeysTab d={d!} toast={toast} reload={() => void qc.invalidateQueries({ queryKey: ['cb-kb-admin'] })} />
          : <BotsTab d={d!} toast={toast} reload={() => { void qc.invalidateQueries({ queryKey: ['cb-kb-admin'] }); void qc.invalidateQueries({ queryKey: ['bb-admin'] }); }} />}
      </div>
    </main>
    {node}
  </div>;
}

function KbTab({ d, toast, reload }: { d: KbAdminPayload; toast: (t: string) => void; reload: () => void }) {
  const scopes = d.scopes?.length ? d.scopes : SCOPES_FALLBACK;
  const cats = d.categories?.length ? d.categories : CATS_FALLBACK;
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('همهٔ دسته‌ها');
  const [scope, setScope] = useState('همهٔ محدوده‌ها');
  const [mode, setMode] = useState<'list' | 'add' | 'edit' | 'preview'>('list');
  const [cur, setCur] = useState<KbRow | null>(null);
  const [del, setDel] = useState<KbRow | null>(null);

  const rows = useMemo(() => {
    const needle = q.trim();
    return (d.kb ?? []).filter((e) => {
      if (cat !== 'همهٔ دسته‌ها' && (e.category || 'مدارک') !== cat) return false;
      if (scope !== 'همهٔ محدوده‌ها' && (e.scope || scopes[0]) !== scope) return false;
      if (!needle) return true;
      return `${e.title}\n${e.body}`.includes(needle);
    });
  }, [d.kb, q, cat, scope, scopes]);

  if (mode === 'add' || mode === 'edit') {
    return <KbForm
      entry={mode === 'edit' ? cur : null}
      cats={cats}
      scopes={scopes}
      defaultScope={d.defaultScope || scopes[0]}
      onCancel={() => { setMode('list'); setCur(null); }}
      onSaved={() => { setMode('list'); setCur(null); reload(); toast('ذخیره شد'); }}
    />;
  }
  if (mode === 'preview' && cur) {
    return <KbPreview entry={cur} onBack={() => setMode('list')} onEdit={() => setMode('edit')} />;
  }

  const tools = <div className="bk-tools">
    <label className="srch"><I n="search" /><input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="جستجو در عنوان و متن" aria-label="جستجو در پایگاه دانش" /></label>
    <select aria-label="دسته" value={cat} onChange={(e) => setCat(e.target.value)}>
      <option>همهٔ دسته‌ها</option>{cats.map((c) => <option key={c}>{c}</option>)}
    </select>
    <select aria-label="محدوده" value={scope} onChange={(e) => setScope(e.target.value)}>
      <option>همهٔ محدوده‌ها</option>{scopes.map((s) => <option key={s}>{s}</option>)}
    </select>
    <button className="btn pri sm" type="button" onClick={() => { setCur(null); setMode('add'); }}><I n="plus" />افزودن مدخل</button>
  </div>;

  if (!(d.kb ?? []).length) {
    return <>{tools}<div className="bk-empty"><b>هنوز مدخلی نیست</b><p>اولین متن دانش را اضافه کنید تا پاسخ خودکار از روی آن ساخته شود.</p>
      <button className="btn pri" type="button" onClick={() => setMode('add')}>افزودن مدخل</button></div></>;
  }

  return <>
    {tools}
    <ul className="bk-list">{rows.map((e) => {
      const on = e.active === true || e.active === 1;
      return <li key={e.id} className="bk-row">
        <div className="r1"><h3>{e.title}</h3>
          <button type="button" className={`sw${on ? ' on' : ''}`} aria-pressed={on}
            onClick={async () => { try { await bbFetch('/bale-bot/customer-bot/admin/kb/active', { body: { id: e.id, active: !on } }); reload(); } catch (x) { toast(x instanceof BbError ? x.message : 'انجام نشد.'); } }}>
            <i /><span>{on ? 'فعال' : 'غیرفعال'}</span></button></div>
        <div className="meta">
          <span className="chip cat">{e.category || 'مدارک'}</span>
          <span className="chip sc">{e.scope || scopes[0]}</span>
          {on ? null : <span className="chip off">خاموش</span>}
          {e.updated_at ? <span className="muted" style={{ fontSize: 12, color: 'var(--nf-ink-muted)' }}>به‌روز، {jalaliSaved(e.updated_at)}</span> : null}
        </div>
        <p className="body">{e.body}</p>
        <div className="acts">
          <button className="btn gh sm" type="button" onClick={() => { setCur(e); setMode('edit'); }}>ویرایش</button>
          <button className="btn gh sm" type="button" onClick={() => { setCur(e); setMode('preview'); }}>پیش‌نمایش</button>
          <button className="btn gh sm" type="button" onClick={() => setDel(e)}>حذف</button>
        </div>
      </li>;
    })}</ul>
    {del ? <div className="bk-modal" role="dialog" aria-modal="true" aria-labelledby="mdt"><div className="bk-dialog">
      <h3 id="mdt">این مدخل حذف شود؟</h3>
      <p>«{del.title}» از پایگاه دانش برداشته می‌شود. پاسخ خودکار دیگر از روی این متن ساخته نمی‌شود.</p>
      <div className="bk-actions">
        <button className="btn dng" type="button" onClick={async () => { try { await bbFetch('/bale-bot/customer-bot/admin/kb/delete', { body: { id: del.id } }); setDel(null); reload(); toast('حذف شد'); } catch (x) { toast(x instanceof BbError ? x.message : 'انجام نشد.'); } }}>حذف مدخل</button>
        <button className="btn gh" type="button" onClick={() => setDel(null)}>انصراف</button>
      </div>
    </div></div> : null}
  </>;
}

function KbForm({ entry, cats, scopes, defaultScope, onCancel, onSaved }: {
  entry: KbRow | null; cats: string[]; scopes: string[]; defaultScope: string;
  onCancel: () => void; onSaved: () => void;
}) {
  const [title, setTitle] = useState(entry?.title ?? '');
  const [body, setBody] = useState(entry?.body ?? '');
  const [category, setCategory] = useState(entry?.category || cats[0] || 'مدارک');
  const [scope, setScope] = useState(entry?.scope || defaultScope || scopes[0]);
  const [on, setOn] = useState(entry ? (entry.active === true || entry.active === 1) : true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = async () => {
    if (!title.trim() || !body.trim() || saving) return;
    setSaving(true); setErr(null);
    try {
      await bbFetch('/bale-bot/customer-bot/admin/kb', {
        body: { id: entry?.id ?? null, title: title.trim(), body: body.trim(), active: on, category, scope },
      });
      onSaved();
    } catch (x) {
      setErr(x instanceof BbError ? x.message : 'ارتباط برقرار نشد. دوباره امتحان کنید.');
    } finally { setSaving(false); }
  };

  return <form className="bk-form" onSubmit={(e) => { e.preventDefault(); void save(); }}>
    {err ? <div className="bk-banner err" role="alert"><I n="alert" /><div><b>ذخیره انجام نشد</b>پیام سرور: {err}</div></div> : null}
    {saving ? <div className="bk-banner wait" role="status"><I n="clock" /><div><b>در حال ذخیره</b>لطفاً همین صفحه را باز نگه دارید.</div></div> : null}
    <div className="bk-field"><label htmlFor="kbt">عنوان</label><input id="kbt" name="title" value={title} onChange={(e) => setTitle(e.target.value)} disabled={saving} /></div>
    <div className="bk-field"><span className="flab" id="catl">دسته</span>
      <select aria-labelledby="catl" value={category} disabled={saving} onChange={(e) => setCategory(e.target.value)}>{cats.map((c) => <option key={c}>{c}</option>)}</select></div>
    <div className="bk-field"><span className="flab" id="scl">محدوده</span>
      <select aria-labelledby="scl" value={scope} disabled={saving} onChange={(e) => setScope(e.target.value)}>{scopes.map((s) => <option key={s}>{s}</option>)}</select></div>
    <div className="bk-field"><label htmlFor="kbb">متن دانش</label><textarea id="kbb" value={body} onChange={(e) => setBody(e.target.value)} disabled={saving} /></div>
    <div className="bk-foot">
      <button type="button" className={`sw${on ? ' on' : ''}`} aria-pressed={on} disabled={saving} onClick={() => setOn((v) => !v)}><i /><span>{on ? 'فعال' : 'غیرفعال'}</span></button>
      <div className="bk-actions">
        <button type="submit" className="btn pri" aria-disabled={saving} disabled={saving}>{saving ? 'در حال ذخیره' : (entry ? 'ذخیرهٔ تغییرات' : 'ذخیرهٔ مدخل')}</button>
        <button type="button" className="btn gh" onClick={onCancel} disabled={saving}>انصراف</button>
      </div>
    </div>
  </form>;
}

/** Preview uses only active KB texts from the server — never a model. */
function KbPreview({ entry, onBack, onEdit }: { entry: KbRow; onBack: () => void; onEdit: () => void }) {
  const [q, setQ] = useState(entry.title);
  const [out, setOut] = useState<{ ok: boolean; text: string } | null>({ ok: true, text: entry.body });
  const [busy, setBusy] = useState(false);
  const run = async () => {
    const question = q.trim(); if (!question) return;
    setBusy(true);
    try {
      const r = await bbFetch<{ ok: boolean; text: string }>('/bale-bot/customer-bot/admin/kb/preview', { body: { question } });
      setOut({ ok: r.ok, text: r.text });
    } catch {
      setOut({ ok: false, text: 'الان نمی‌توانم این را قطعی بگویم. از منوی زیر «واگذاری به کارشناس» را بزنید تا همکارم ادامه دهد.' });
    } finally { setBusy(false); }
  };
  return <div className="bk-prev">
    <b>پیش‌نمایش پاسخ خودکار</b>
    <p style={{ margin: 0, color: 'var(--nf-ink-muted)', fontSize: 13 }}>این پیش‌نمایش از روی متن دانش فعال است؛ نرخ و وعده‌ی تصویب داده نمی‌شود.</p>
    <div className="bk-field"><label htmlFor="pq">پرسش نمونه</label>
      <input id="pq" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void run(); }} /></div>
    <div className="bk-actions" style={{ marginBottom: 12 }}><button className="btn pri sm" type="button" disabled={busy} onClick={() => void run()}>{busy ? 'در حال ساخت پیش‌نمایش' : 'پیش‌نمایش'}</button></div>
    {out ? <><div className="q">{q}</div>
      <div className="bc-bub in" style={{ maxWidth: '100%' }}><span className="bb-ai">پاسخ خودکار</span>{out.text}</div></> : null}
    <div className="bk-actions">
      <button className="btn gh" type="button" onClick={onEdit}>ویرایش همین مدخل</button>
      <button className="btn gh" type="button" onClick={onBack}>برگشت به فهرست</button>
    </div>
  </div>;
}

type KeyKind = 'openai' | 'deepseek';
const KEY_LABEL: Record<KeyKind, string> = { openai: 'OpenAI', deepseek: 'DeepSeek' };

function KeysTab({ d, toast, reload }: { d: KbAdminPayload; toast: (t: string) => void; reload: () => void }) {
  return <>
    <KeyCard kind="openai" meta={d.openai} toast={toast} reload={reload} />
    <KeyCard kind="deepseek" meta={d.deepseek} toast={toast} reload={reload} />
  </>;
}

function KeyCard({ kind, meta, toast, reload }: { kind: KeyKind; meta: SecretMeta; toast: (t: string) => void; reload: () => void }) {
  const name = KEY_LABEL[kind];
  const [mode, setMode] = useState<'idle' | 'replace' | 'saving' | 'empty'>('idle');
  const [val, setVal] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [test, setTest] = useState<{ ok: boolean; title: string; message: string } | null>(null);
  const [del, setDel] = useState(false);
  const saved = !!meta.set;
  const empty = !saved || mode === 'empty';
  const replacing = mode === 'replace';
  const saving = mode === 'saving';

  const save = async () => {
    if (val.trim().length < 8 || saving) return;
    const toSend = val;
    setVal(''); // never keep the key in the field once we submit
    setMode('saving'); setErr(null); setTest(null);
    try {
      await bbFetch('/bale-bot/customer-bot/admin/secret', { body: { kind, value: toSend } });
      setMode('idle');
      reload();
      toast('کلید ثبت شد');
    } catch (x) {
      setErr(x instanceof BbError ? x.message : 'کلید پذیرفته نشد. کلید را دوباره وارد کنید.');
      setMode(saved ? 'replace' : 'idle');
    }
  };

  const runTest = async () => {
    setTest(null);
    try {
      const r = await bbFetch<{ ok: boolean; title: string; message: string }>('/bale-bot/customer-bot/admin/secret/test', { body: { kind } });
      setTest({ ok: r.ok, title: r.title, message: r.message });
    } catch (x) {
      setTest({ ok: false, title: 'آزمایش کلید از سرور', message: x instanceof BbError ? x.message : 'کلید پذیرفته نشد.' });
    }
  };

  let mid: React.ReactNode;
  if (saving) mid = <>
    <div className="bk-banner wait" role="status"><I n="clock" /><div><b>در حال ذخیره</b>کلید روی سرور ثبت می‌شود و بعد از آن در این صفحه دیده نمی‌شود.</div></div>
    <div className="bk-field"><label htmlFor={`k-${name}`}>کلید <span dir="ltr">{name}</span></label>
      <input id={`k-${name}`} className="pw" type="password" autoComplete="off" disabled value="" aria-label={`کلید ${name}، در حال ذخیره`} /></div>
    <div className="bk-actions"><button className="btn pri" type="button" aria-disabled="true" tabIndex={-1}>در حال ذخیره</button>
      <button className="btn gh" type="button" aria-disabled="true" tabIndex={-1}>انصراف</button></div>
  </>;
  else if (err && (replacing || !saved)) mid = <>
    <div className="bk-banner err" role="alert"><I n="alert" /><div><b>ذخیره انجام نشد</b>پیام سرور: {err}</div></div>
    <div className="bk-field"><label htmlFor={`k-${name}`}>کلید <span dir="ltr">{name}</span></label>
      <input id={`k-${name}`} className="pw" type="password" autoComplete="off" value={val} onChange={(e) => setVal(e.target.value)} aria-label={`کلید ${name}، نمایش داده نمی‌شود`} /></div>
    <div className="bk-actions">
      <button className="btn pri" type="button" onClick={() => void save()}>ذخیره کلید</button>
      <button className="btn gh" type="button" onClick={() => { setErr(null); setVal(''); setMode('idle'); }}>انصراف</button>
    </div>
  </>;
  else if (replacing) mid = <>
    <div className="bk-field"><label htmlFor={`k-${name}`}>کلید تازه‌ی <span dir="ltr">{name}</span></label>
      <input id={`k-${name}`} className="pw" type="password" autoComplete="off" value={val} onChange={(e) => setVal(e.target.value)} aria-label={`کلید تازه‌ی ${name}، نمایش داده نمی‌شود`} /></div>
    <div className="bk-actions">
      <button className="btn pri" type="button" onClick={() => void save()}>ذخیره کلید تازه</button>
      <button className="btn gh" type="button" onClick={() => { setVal(''); setMode('idle'); }}>انصراف</button>
    </div>
  </>;
  else if (empty) mid = <>
    <span className="bk-st off">ثبت نشده</span>
    <div className="bk-field"><label htmlFor={`k-${name}`}>کلید <span dir="ltr">{name}</span></label>
      <input id={`k-${name}`} className="pw" type="password" autoComplete="off" value={val} onChange={(e) => setVal(e.target.value)} aria-label={`کلید ${name}، نمایش داده نمی‌شود`} /></div>
    <div className="bk-actions">
      <button className="btn pri" type="button" onClick={() => void save()}>ذخیره کلید</button>
      <button className="btn gh" type="button" onClick={() => void runTest()}>آزمایش کلید</button>
    </div>
  </>;
  else mid = <>
    <div className="bk-st"><I n="check" />ثبت شده{meta.savedAt ? `، ${jalaliSaved(meta.savedAt)}` : ''}</div>
    {test?.ok ? <div className="bk-banner ok" role="status"><I n="check" /><div><b>{test.title}</b>{test.message}</div></div> : null}
    {test && !test.ok ? <div className="bk-banner err" role="alert"><I n="alert" /><div><b>{test.title}</b>{test.message}</div></div> : null}
    <div className="bk-actions">
      <button className="btn pri sm" type="button" onClick={() => { setVal(''); setTest(null); setMode('replace'); }}>جایگزینی کلید</button>
      <button className="btn gh sm" type="button" onClick={() => setDel(true)}>حذف کلید</button>
      <button className="btn gh sm" type="button" onClick={() => void runTest()}>آزمایش کلید</button>
    </div>
  </>;

  return <section className="bk-key" aria-label={`کلید ${name}`}>
    <h3 dir="ltr">{name}</h3>
    {mid}
    {del ? <div className="bk-modal" role="dialog" aria-modal="true" aria-labelledby={`mdt-${kind}`}><div className="bk-dialog">
      <h3 id={`mdt-${kind}`}>کلید <span dir="ltr">{name}</span> حذف شود؟</h3>
      <p>پس از حذف، پاسخ خودکار با این سرویس کار نمی‌کند تا کلید تازه‌ای ثبت شود. خود کلید در این صفحه دیده نمی‌شود.</p>
      <div className="bk-actions">
        <button className="btn dng" type="button" onClick={async () => { try { await bbFetch('/bale-bot/customer-bot/admin/secret/delete', { body: { kind } }); setDel(false); setTest(null); reload(); toast('کلید حذف شد'); } catch (x) { toast(x instanceof BbError ? x.message : 'انجام نشد.'); } }}>حذف کلید</button>
        <button className="btn gh" type="button" onClick={() => setDel(false)}>انصراف</button>
      </div>
    </div></div> : null}
  </section>;
}

function BotsTab({ d, toast, reload }: { d: KbAdminPayload; toast: (t: string) => void; reload: () => void }) {
  const expertsQ = useQuery<{ hasKey: boolean; noSend: number[]; experts: BbAdminExpert[] }>({
    queryKey: ['bb-admin'], queryFn: () => bbFetch('/bale-bot/admin/bots'),
  });
  const ex = (expertsQ.data?.experts ?? []).filter((e) => e.id !== 3);
  const [w, setW] = useState<null | { k: 'wiz'; s: number; userId: number | null; replace: boolean } | { k: 'saved'; e: BbAdminExpert } | { k: 'off'; e: BbAdminExpert }>(null);
  const [tok, setTok] = useState('');
  const [tokBusy, setTokBusy] = useState(false);
  const shared = d.sharedBot;
  const saveShared = async () => {
    if (tok.trim().length < 8 || tokBusy) return;
    const toSend = tok; setTok(''); setTokBusy(true);
    try {
      await bbFetch('/bale-bot/customer-bot/admin/shared-bot/token', { body: { token: toSend } });
      reload(); toast('توکن ربات نفیس وام ثبت شد');
    } catch (x) { toast(x instanceof BbError ? x.message : 'انجام نشد.'); }
    finally { setTokBusy(false); }
  };
  const stChip = (status: string) => status === 'on'
    ? <span className="chip s"><I n="check" />وصل</span>
    : status === 'err' ? <span className="chip r"><I n="alert" />خطای توکن</span>
    : <span className="chip">قطع</span>;

  return <>
    <ul className="bk-bots">
      <li className="shared">
        <span className="ava c2 lg2" aria-hidden="true">ن</span>
        <div className="tx">
          <b>ربات نفیس وام</b>
          {shared?.username ? <span className="u" dir="ltr">@{shared.username}</span> : null}
          <span className="chip src">ربات مشترک مشتریان</span>
        </div>
        {stChip(shared?.status || 'off')}
        {shared?.hasToken && shared.connectedAt
          ? <span style={{ fontSize: 13, color: 'var(--nf-ink-muted)' }}>وصل از {jalaliSaved(shared.connectedAt)}</span>
          : shared?.hasToken ? <span style={{ fontSize: 13, color: 'var(--nf-ink-muted)' }}>توکن ثبت شده</span>
          : null}
        {!shared?.hasToken ? <div className="bk-field" style={{ gridColumn: '1 / -1', marginTop: 8 }}>
          <label htmlFor="shared-tok">توکن ربات نفیس وام</label>
          <input id="shared-tok" className="pw" type="password" autoComplete="off" value={tok} onChange={(e) => setTok(e.target.value)} disabled={tokBusy} aria-label="توکن ربات نفیس وام، نمایش داده نمی‌شود" />
          <div className="bk-actions" style={{ marginTop: 8 }}>
            <button className="btn pri sm" type="button" disabled={tokBusy || tok.trim().length < 8} onClick={() => void saveShared()}>{tokBusy ? 'در حال ذخیره' : 'ذخیره توکن'}</button>
          </div>
        </div> : null}
      </li>
      {ex.map((e) => {
        const b = e.bot; const st = b?.status ?? 'off';
        return <li key={e.id}>
          <span className="ava c1" aria-hidden="true">{e.name.trim()[0]}</span>
          <div className="tx">
            <b>ربات {e.name}</b>
            {b?.username ? <span className="u" dir="ltr">@{b.username}</span> : <span className="m">ربات وصل نیست</span>}
          </div>
          {stChip(st)}
          <div className="ac">{st === 'on' && b?.hasToken
            ? <button className="btn gh sm" type="button" onClick={() => setW({ k: 'saved', e })}>تنظیمات</button>
            : st === 'err' && b?.hasToken
              ? <button className="btn pri sm" type="button" onClick={() => setW({ k: 'wiz', s: 2, userId: e.id, replace: true })}>تعویض توکن</button>
              : <button className="btn pri sm" type="button" onClick={() => setW({ k: 'wiz', s: 2, userId: e.id, replace: false })}>وصل کردن ربات</button>}
          </div>
        </li>;
      })}
    </ul>
    <p style={{ margin: '12px 0 0', color: 'var(--nf-ink-soft)', fontSize: 13, lineHeight: 1.7 }}>مشتری بدون کارشناس از ربات مشترک وارد می‌شود و طبق قاعده‌ی توزیع فعلی به کارشناس می‌رسد. مشتری که کارشناس دارد، به همان کارشناسِ خود وصل می‌شود و لید تازه ساخته نمی‌شود.</p>
    <div className="bk-actions" style={{ marginTop: 16 }}>
      <button className="btn pri sm" type="button" onClick={() => setW({ k: 'wiz', s: 1, userId: null, replace: false })}><I n="plus" />وصل کردن ربات کارشناس</button>
    </div>
    {w?.k === 'wiz' ? <BotWizard experts={ex} init={w} close={() => setW(null)} toast={toast} done={(e) => { setW(null); toast(`ربات ${e.name} وصل شد؛ پیام‌ها از همین حالا می‌رسد.`); reload(); }} /> : null}
    {w?.k === 'saved' ? <Saved e={w.e} close={() => setW(null)} toast={toast} reload={reload} onReplace={() => setW({ k: 'wiz', s: 2, userId: w.e.id, replace: true })} onOff={() => setW({ k: 'off', e: w.e })} /> : null}
    {w?.k === 'off' ? <Confirm title={`اتصال ربات ${w.e.name} قطع شود؟`} items={['توکن از CRM پاک می‌شود. باطل کردن خود توکن فقط در @botfather بله ممکن است.', 'گفتگوهای قبلی در CRM می‌ماند.', 'پیام‌هایی که بعد از قطع برسد فقط ۲۴ ساعت روی بله می‌ماند؛ بعد از آن به CRM نمی‌آید.']}
      foot={<><button className="btn dng" type="button" onClick={async () => { const e = w.e; setW(null); try { await bbFetch(`/bale-bot/admin/bots/${e.bot!.id}/disconnect`, { body: {} }); toast('اتصال ربات قطع شد'); reload(); } catch (x) { toast(x instanceof BbError ? x.message : 'انجام نشد.'); } }}>قطع اتصال</button><button className="btn gh" type="button" onClick={() => setW(null)}>انصراف</button></>} /> : null}
  </>;
}
