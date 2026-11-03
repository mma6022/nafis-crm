/* «صفحه‌ی لینک‌ها» v1.0 — CRM admin (design: nafis-design/screens/links, Armita; approved by Mohammad t781s3122).
   Admin + sales_manager only (server-enforced: /api/link-page/*). Behind flag.links_page: while off /api/link-page/me is 404 → NotFound. */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type KeyboardEvent as RKE, type PointerEvent as RPE } from 'react';
import NotFound from '@/pages/not-found';
import { GLYPHS, ICONS, NAFIS_MARK, NAFIS_MARK_VIEWBOX } from './glyphs';
import { TY, TGRP, LOGOS, LN, buildUrl, charLen, fa, shown } from './rules';
import './link-page.css';

type LogoRef = { kind: 'builtin'; key: string } | { kind: 'upload'; id: number; mime?: string | null; name?: string | null };
type Link = { id: number; type: string; title: string; value: string; url: string; visible: boolean; position: number; logo: LogoRef; logoId: number | null; clicks: number; createdAt: string; isNew: boolean };
type St = {
  enabled: boolean; canManage: boolean; canEditHeader: boolean; window: { from: string; to: string };
  page: { id: number; slug: string; name: string; intro: string; logo: LogoRef; logoId: number | null; url: string };
  links: Link[]; builtinLogos: { id: number; key: string; name: string }[]; uploads: LogoRef[]; sitePages: [string, string][]; leadUrl: string;
};
type Me = { enabled: boolean; canManage: boolean; canEditHeader: boolean; role?: string };
class HttpErr extends Error { constructor(public status: number, msg: string, public field?: string) { super(msg); } }

const base = () => (import.meta.env.BASE_URL || '/').replace(/\/$/, '');
async function req<T>(p: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${base()}/api${p}`, { credentials: 'include', ...init, headers: { 'content-type': 'application/json' } });
  const b = await r.json().catch(() => ({}));
  if (!r.ok) { const e = b as { error?: string; message?: string; field?: string }; throw new HttpErr(r.status, e.message || e.error || `HTTP ${r.status}`, e.field); }
  return b as T;
}
const PAGE_URL = 'https://nafisvam.com/links';
const logoSrc = (id: number) => `${base()}/api/link-page/logos/${id}`;
const sq = (s: string) => `«${s}»`;

export function I({ n, cls = 'i' }: { n: string; cls?: string }) {
  return <svg className={cls} viewBox="0 0 24 24" aria-hidden="true" dangerouslySetInnerHTML={{ __html: ICONS[n.replace(/^i-/, '')] ?? '' }} />;
}
export function Logo({ r }: { r: LogoRef | 'custom' }) {
  if (r === 'custom') return <span className="lg cu" aria-hidden="true">ن</span>;
  if (r.kind === 'upload') return <span className="lg up" aria-hidden="true"><img src={logoSrc(r.id)} alt="" /></span>;
  if (r.key === 'nafis') return <span className="lg nf"><svg viewBox={NAFIS_MARK_VIEWBOX} aria-hidden="true" dangerouslySetInnerHTML={{ __html: NAFIS_MARK }} /></span>;
  return <span className={`lg lg-${r.key}`}><svg viewBox="0 0 24 24" aria-hidden="true" dangerouslySetInnerHTML={{ __html: GLYPHS[r.key] ?? GLYPHS.web }} /></span>;
}
function Avatar({ r }: { r: LogoRef }) {
  return <div className="lp-av">{r.kind === 'upload' ? <img src={logoSrc(r.id)} alt="" /> : <svg viewBox={NAFIS_MARK_VIEWBOX} aria-hidden="true" dangerouslySetInnerHTML={{ __html: NAFIS_MARK }} />}</div>;
}
const fmtDay = (d: string, year: boolean) => new Intl.DateTimeFormat('fa-IR-u-ca-persian-nu-arabext', { timeZone: 'Asia/Tehran', day: 'numeric', month: 'long', ...(year ? { year: 'numeric' } : {}) }).format(new Date(d + 'T12:00:00Z'));

/* the public page, exactly as nafisvam.com/links renders it (used in the live preview) */
export function PubPage({ name, intro, logo, links }: { name: string; intro: string; logo: LogoRef; links: { id: number; title: string; type: string; logo: LogoRef }[] }) {
  return <div className="lp">
    <Avatar r={logo} />
    <h1>{name}</h1>
    {intro ? <p className="lp-in">{intro}</p> : null}
    {links.length ? <ul className="lp-l" aria-label={`لینک‌های ${name}`}>{links.map((l) => <li key={l.id}><a className={`lb${l.type === 'lead' ? ' lead' : ''}`} href={`#l${l.id}`} tabIndex={-1} onClick={(e) => e.preventDefault()}><Logo r={l.logo} /><span className="t">{l.title}</span><span className="go"><I n="i-chev" /></span></a></li>)}</ul>
      : <p className="lp-e">برای دیدن طرح‌ها و ثبت درخواست، به سایت نفیس وام سر بزن.</p>}
    <div className="lp-f"><a href="https://nafisvam.com/" tabIndex={-1} onClick={(e) => e.preventDefault()}>nafisvam.com</a><span>گروه مالی نفیس</span></div>
  </div>;
}

/* ---------- modal shell (focus in, Esc, focus back, background inert) ---------- */
function useModalFocus(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const back = document.activeElement as HTMLElement | null;
    const t = setTimeout(() => ref.current?.querySelector<HTMLElement>('[data-autofocus], input, textarea, button[aria-checked="true"], button')?.focus(), 0);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
      if (e.key === 'Tab' && ref.current) {
        const f = [...ref.current.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input, textarea, [tabindex="0"]')].filter((x) => x.offsetParent !== null);
        if (!f.length) return; const first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => { clearTimeout(t); document.removeEventListener('keydown', onKey); back?.focus?.(); };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  return ref;
}
function Modal({ cls, title, sub, steps, onClose, children, foot }: { cls: string; title: string; sub: string; steps?: ReactNode; onClose: () => void; children: ReactNode; foot: ReactNode }) {
  const ref = useModalFocus(true, onClose);
  return <div className="mx" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}><div ref={ref} className={`md ${cls}`} role="dialog" aria-modal="true" aria-labelledby="mdt">
    <div className="mh"><div className="t"><h2 id="mdt">{title}</h2><p>{sub}</p>{steps}</div><button className="ib" type="button" aria-label="بستن" onClick={onClose}><I n="i-x" /></button></div>
    <div className="mb">{children}</div><div className="mf">{foot}</div></div></div>;
}
const UPI = <p className="upi">لوگوی خودت: PNG یا SVG، تا ۲۰۰ کیلوبایت، بهتر است مربعی و دست‌کم ۱۲۸ در ۱۲۸ پیکسل باشد.</p>;

/* ---------- logo upload (client pre-check mirrors the server; the server sanitizes SVG) ---------- */
type Up = { state: 'ok' | 'err' | 'busy'; file: string; kb: number; dims?: string; msg?: string };
const MAX = 200 * 1024;
async function dims(f: File): Promise<string | undefined> {
  return new Promise((res) => { const u = URL.createObjectURL(f); const im = new Image(); im.onload = () => { res(im.naturalWidth && im.naturalHeight ? `${fa(im.naturalWidth)} در ${fa(im.naturalHeight)} پیکسل` : undefined); URL.revokeObjectURL(u); }; im.onerror = () => { res(undefined); URL.revokeObjectURL(u); }; im.src = u; });
}
async function uploadLogo(f: File, keepName: string): Promise<{ up: Up; id?: number }> {
  const kb = Math.max(1, Math.ceil(f.size / 1024)); const keep = ` تا آن موقع لوگوی ${keepName} می‌ماند.`;
  if (f.size > MAX) return { up: { state: 'err', file: f.name, kb, msg: `حجم این فایل ${fa(kb)} کیلوبایت است؛ حداکثر ۲۰۰ کیلوبایت. فایل کوچک‌تری انتخاب کن.${keep}` } };
  if (/jpe?g$/i.test(f.type) || /\.jpe?g$/i.test(f.name)) return { up: { state: 'err', file: f.name, kb, msg: `این فایل JPG است؛ فقط PNG یا SVG قبول می‌شود.${keep}` } };
  if (!/^image\/(png|svg\+xml)$/.test(f.type) && !/\.(png|svg)$/i.test(f.name)) return { up: { state: 'err', file: f.name, kb, msg: `فقط PNG یا SVG قبول می‌شود.${keep}` } };
  const r = await fetch(`${base()}/api/link-page/logos?name=${encodeURIComponent(f.name.replace(/\.[^.]+$/, '').slice(0, 60))}`, { method: 'POST', credentials: 'include', headers: { 'content-type': f.type || 'application/octet-stream' }, body: f });
  const b = await r.json().catch(() => ({})) as { id?: number; message?: string };
  if (!r.ok || !b.id) return { up: { state: 'err', file: f.name, kb, msg: `${b.message ?? 'آپلود انجام نشد؛ دوباره امتحان کن.'}${keep}` } };
  return { up: { state: 'ok', file: f.name, kb, dims: await dims(f) }, id: b.id };
}
function UpRow({ up, onPick, onRemove }: { up: Up; onPick: () => void; onRemove?: () => void }) {
  if (up.state === 'err') return <><div className="lupr err"><I n="i-alert" /><div className="tx"><b dir="ltr">{up.file}</b><span>{fa(up.kb)} کیلوبایت</span></div><button className="btn gh sm" type="button" onClick={onPick}><I n="i-upload" />انتخاب فایل دیگر</button></div>
    <p className="uperr" role="alert"><I n="i-alert" />{up.msg}</p></>;
  return <div className="lupr ok" aria-busy={up.state === 'busy'}><Logo r="custom" /><div className="tx"><b dir="ltr">{up.file}</b><span>{up.state === 'busy' ? 'در حال بارگذاری…' : `${fa(up.kb)} کیلوبایت${up.dims ? `، ${up.dims}` : ''}، آماده`}</span></div>
    <button className="btn gh sm" type="button" onClick={onPick}><I n="i-upload" />عوض کردن</button>{onRemove ? <button className="ib" type="button" aria-label="برداشتن لوگوی آپلودشده" onClick={onRemove}><I n="i-trash" /></button> : null}</div>;
}
const pickFile = (cb: (f: File) => void) => { const i = document.createElement('input'); i.type = 'file'; i.accept = '.png,.svg,image/png,image/svg+xml'; i.onchange = () => { const f = i.files?.[0]; if (f) cb(f); }; i.click(); };
function LogoTile({ k, sel, onSel }: { k: string; sel: boolean; onSel: () => void }) {
  return <button className="lgo" type="button" role="radio" aria-checked={sel} aria-label={`لوگوی ${LN[k]}`} onClick={onSel}>{sel ? <span className="ok"><I n="i-check" /></span> : null}<Logo r={{ kind: 'builtin', key: k }} /><span aria-hidden="true">{LN[k]}</span></button>;
}
function UploadTile({ sel, onClick }: { sel: boolean; onClick: () => void }) {
  return <button className="lgo upl" type="button" role="radio" aria-checked={sel} onClick={onClick}>{sel ? <span className="ok"><I n="i-check" /></span> : null}<I n="i-upload" /><span>آپلود لوگو</span></button>;
}
/* arrow keys inside a radiogroup (roving) */
const radioKeys = (e: RKE<HTMLElement>) => {
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
  const all = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('[role=radio]')]; const i = all.indexOf(document.activeElement as HTMLButtonElement); if (i < 0) return;
  e.preventDefault(); const d = e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? 1 : -1; const n = all[(i + d + all.length) % all.length]; n.focus(); n.click();
};

/* ---------- wizard (add = step 1 → 2; edit opens on step 2) ---------- */
type Lg = { kind: 'builtin'; key: string } | { kind: 'upload'; id: number };
type Wz = { mode: 'add' | 'edit'; id?: number; step: 1 | 2; type: string; logo: Lg; logoTouched: boolean; up?: Up; title: string; titleTouched: boolean; value: string; err?: { field?: string; msg: string }; busy?: boolean; clicks?: number; origTitle?: string };
const defTitle = (type: string, value: string, pages: [string, string][]) => type === 'lead' ? 'درخواست وام آنلاین' : type === 'site' ? (pages.find((p) => p[1] === value)?.[0] ?? '') : TY[type]?.n ?? '';
const logoName = (l: Lg) => (l.kind === 'upload' ? 'آپلودشده' : LN[l.key]);

function Wizard({ st, wz, setWz, onClose, onSaved }: { st: St; wz: Wz; setWz: (f: (w: Wz) => Wz) => void; onClose: () => void; onSaved: (title: string, mode: 'add' | 'edit') => void }) {
  const t = TY[wz.type];
  const b = buildUrl(wz.type, wz.value, st.sitePages, st.leadUrl);
  const tl = charLen(wz.title.trim());
  const titleOk = tl > 0 && tl <= 40;
  const valErr = wz.value.trim() && !b.ok ? b.error : wz.err?.field === 'value' ? wz.err.msg : '';
  const ok = b.ok && titleOk && !wz.busy && wz.up?.state !== 'busy';
  const lgId = (l: Lg) => (l.kind === 'upload' ? l.id : st.builtinLogos.find((x) => x.key === l.key)?.id ?? null);
  const pick = () => pickFile(async (f) => {
    const keep = logoName(wz.logo);
    setWz((w) => ({ ...w, up: { state: 'busy', file: f.name, kb: Math.ceil(f.size / 1024) } }));
    const r = await uploadLogo(f, keep);
    setWz((w) => ({ ...w, up: r.up, ...(r.id ? { logo: { kind: 'upload', id: r.id }, logoTouched: true } : {}) }));
  });
  const save = async () => {
    if (!ok) return;
    setWz((w) => ({ ...w, busy: true, err: undefined }));
    const body = { type: wz.type, title: wz.title.trim(), value: t.ask === 'lead' ? '' : wz.value, logoId: lgId(wz.logo) };
    try {
      if (wz.mode === 'add') await req('/link-page/links', { method: 'POST', body: JSON.stringify(body) });
      else await req(`/link-page/links/${wz.id}`, { method: 'PATCH', body: JSON.stringify(body) });
      onSaved(body.title, wz.mode);
    } catch (e) { const he = e as HttpErr; setWz((w) => ({ ...w, busy: false, err: { field: he.field, msg: he.message } })); }
  };
  const steps = <ol className="wst" aria-label="مراحل">
    <li className={wz.step === 2 ? 'dn' : ''} aria-current={wz.step === 1 ? 'step' : undefined}>{wz.step === 2 ? <a href="#step1" onClick={(e) => { e.preventDefault(); setWz((w) => ({ ...w, step: 1 })); }} aria-label="مرحله‌ی ۱، نوع و لوگو، انجام شد؛ برای عوض کردن بزن"><b><I n="i-check" /></b>نوع و لوگو</a> : <><b>۱</b>نوع و لوگو</>}</li>
    <li className={`lbar${wz.step === 2 ? ' on' : ''}`} aria-hidden="true" />
    <li aria-current={wz.step === 2 ? 'step' : undefined}><b>۲</b>عنوان و آدرس</li>
  </ol>;
  const title = wz.mode === 'edit' ? `ویرایش لینک ${sq(wz.origTitle ?? '')}` : 'افزودن لینک';
  if (wz.step === 1) {
    const setType = (k: string) => setWz((w) => ({ ...w, type: k, logo: w.logoTouched ? w.logo : { kind: 'builtin', key: TY[k].lg }, value: k === w.type ? w.value : '', title: w.titleTouched ? w.title : defTitle(k, '', st.sitePages), err: undefined }));
    return <Modal cls="wz" title={title} sub="مرحله ۱ از ۲: نوع و لوگو" steps={steps} onClose={onClose}
      foot={<><button className="btn pri" type="button" onClick={() => setWz((w) => ({ ...w, step: 2 }))} aria-disabled={wz.up?.state === 'busy' ? true : undefined}>بعدی: عنوان و آدرس<I n="i-arrow" /></button><button className="btn gh" type="button" onClick={onClose}>انصراف</button></>}>
      <section className="wsec"><h3>نوع لینک</h3><div role="radiogroup" aria-label="نوع لینک" onKeyDown={radioKeys}>{TGRP.map(([h, ks]) => <div key={h}><p className="tgh">{h}</p><div className="tyg">{ks.map((k) =>
        <button key={k} className="ty" type="button" role="radio" aria-checked={k === wz.type} tabIndex={k === wz.type ? 0 : -1} onClick={() => setType(k)}>{k === wz.type ? <span className="ok"><I n="i-check" /></span> : null}<Logo r={{ kind: 'builtin', key: TY[k].lg }} /><span>{TY[k].n}</span></button>)}</div></div>)}</div></section>
      <section className="wsec"><h3>لوگو <span className="muted">از روی نوع پیشنهاد شد؛ می‌شود عوضش کرد</span></h3>
        <div className="lgl" role="radiogroup" aria-label="لوگو">{LOGOS.map(([k]) => <LogoTile key={k} k={k} sel={wz.logo.kind === 'builtin' && wz.logo.key === k} onSel={() => setWz((w) => ({ ...w, logo: { kind: 'builtin', key: k }, logoTouched: true }))} />)}
          <UploadTile sel={wz.logo.kind === 'upload'} onClick={pick} /></div>
        {wz.up ? <UpRow up={wz.up} onPick={pick} onRemove={() => setWz((w) => ({ ...w, up: undefined, logo: { kind: 'builtin', key: TY[w.type].lg }, logoTouched: false }))} />
          : wz.logo.kind === 'upload' ? <div className="lupr ok"><Logo r={{ kind: 'upload', id: wz.logo.id }} /><div className="tx"><b>لوگوی آپلودشده</b><span>همین حالا روی این لینک است</span></div><button className="btn gh sm" type="button" onClick={pick}><I n="i-upload" />عوض کردن</button></div> : null}
        {UPI}</section>
    </Modal>;
  }
  const selRow = <div className="sel"><Logo r={wz.logo.kind === 'upload' ? { kind: 'upload', id: wz.logo.id } : wz.logo} /><div className="tx"><b>{t.n}</b>لوگو: {logoName(wz.logo)}</div><button className="btn lk sm" type="button" onClick={() => setWz((w) => ({ ...w, step: 1 }))}>عوض کردن نوع یا لوگو</button></div>;
  const titleErr = wz.err?.field === 'title' ? wz.err.msg : '';
  const titleF = (hint?: string) => <div className="fld"><label className="flab" htmlFor="ft">عنوان روی دکمه<span className="lcn">{fa(tl)} از ۴۰</span></label>
    <input id="ft" className={`inp tx${titleErr ? ' er' : ''}`} value={wz.title} maxLength={40} aria-invalid={titleErr ? true : undefined} aria-describedby={titleErr ? 'fte' : undefined} onChange={(e) => { const v = e.target.value; setWz((w) => ({ ...w, title: v, titleTouched: true, err: w.err?.field === 'title' ? undefined : w.err })); }} />
    {titleErr ? <p className="ferr" id="fte" role="alert"><I n="i-alert" />{titleErr}</p> : hint ? <p className="hint">{hint}</p> : null}</div>;
  const built = (url: string, ro?: boolean) => <div className={`bu${ro ? ' ro2' : ''}`}><span className="k"><I n={ro ? 'i-lock' : 'i-check'} />{ro ? 'مقصد ثابت' : 'آدرس ساخته شد'}</span><span className="v">{url}</span>{ro || !/^https:/.test(url) ? null : <a className="btn lk sm" href={url} target="_blank" rel="noopener noreferrer" aria-label="امتحان آدرس در زبانه‌ی تازه"><I n="i-link" />امتحان</a>}</div>;
  const setVal = (v: string) => setWz((w) => ({ ...w, value: v, err: w.err?.field === 'value' ? undefined : w.err }));
  let body: ReactNode;
  if (t.ask === 'lead') {
    body = <>{selRow}<div className="leadbox"><I n="i-flag" /><div><b>این لینک به فرم درخواست وام سایت می‌رود</b>مشتری همان فرم همیشگی سایت را پر می‌کند و سرنخ با منبع «صفحه لینک‌ها» در CRM ثبت می‌شود. فرم یا سؤال تازه‌ای ساخته نمی‌شود.</div></div>
      {titleF('روی صفحه با رنگ اصلی نفیس، برجسته دیده می‌شود.')}<div className="fld"><span className="flab">مقصد</span>{built(st.leadUrl, true)}<p className="hint"><span className="chip b"><I n="i-flag" />منبع سرنخ: صفحه لینک‌ها</span></p></div></>;
  } else if (t.ask === 'page') {
    body = <>{selRow}<div className="fld"><span className="flab" id="spl">کدام صفحه‌ی سایت؟</span><ul className="spl" role="radiogroup" aria-labelledby="spl" onKeyDown={radioKeys}>{st.sitePages.map(([n, p]) =>
      <li key={p}><button className="spo" type="button" role="radio" aria-checked={p === wz.value} tabIndex={p === wz.value || (!wz.value && p === '/') ? 0 : -1} onClick={() => setWz((w) => ({ ...w, value: p, title: w.titleTouched ? w.title : n, err: undefined }))}><span className="rd" aria-hidden="true" /><span className="n">{n}</span><span className="p">{p}</span></button></li>)}</ul>
      <p className="hint">فرم درخواست وام نوع جداست تا منبع سرنخ درست ثبت شود.</p></div>
      {titleF(wz.value && !wz.titleTouched ? 'از نام صفحه پر شد؛ اگر خواستی عوضش کن.' : undefined)}{b.ok ? built(b.url) : null}</>;
  } else {
    const isUser = t.ask === 'user';
    const hint = isUser ? 'فقط نام کاربری؛ اگر لینک کامل را بچسبانی، نام کاربری خودش جدا می‌شود.' : t.ask === 'mob' ? 'شماره‌ی موبایل با ۰۹؛ آدرس واتساپ خودش ساخته می‌شود.'
      : t.ask === 'phone' ? 'شماره‌ی تلفن با کد شهر یا موبایل با ۰۹.' : t.ask === 'email' ? 'نشانی ایمیل؛ با زدن دکمه، برنامه‌ی ایمیل باز می‌شود.' : 'آدرس کامل که با https:// شروع می‌شود.';
    const input = <input id="fv" className="inp lt" dir="ltr" value={wz.value} inputMode={t.ask === 'mob' || t.ask === 'phone' ? 'tel' : t.ask === 'email' ? 'email' : t.ask === 'url' ? 'url' : 'text'}
      autoCapitalize="off" autoCorrect="off" spellCheck={false} placeholder={t.ask === 'url' ? 'https://' : undefined} aria-invalid={valErr ? true : undefined} aria-describedby={valErr ? 'fe' : undefined} onChange={(e) => setVal(e.target.value)} />;
    body = <>{selRow}{titleF()}<div className="fld"><label className="flab" htmlFor="fv">{t.f}</label>
      {isUser ? <div className={`ig${valErr ? ' er' : ''}`}><span className="pre" aria-hidden="true">@</span>{input}</div> : input}
      {valErr ? <p className="ferr" id="fe" role="alert"><I n="i-alert" />{valErr}</p> : <><p className="hint">{hint}</p>{b.ok ? built(b.url) : null}</>}</div>
      {wz.mode === 'edit' ? <p className="hint">کلیک‌های این لینک ({fa(wz.clicks ?? 0)} در ۳۰ روز گذشته) با ویرایش صفر نمی‌شود.</p> : null}</>;
  }
  const genErr = wz.err && wz.err.field !== 'title' && wz.err.field !== 'value' ? <p className="ferr" role="alert"><I n="i-alert" />{wz.err.msg}</p> : null;
  return <Modal cls="wz" title={title} sub={`مرحله ۲ از ۲: عنوان و آدرس${wz.mode === 'edit' ? '؛ بعد از ذخیره همان لحظه روی صفحه' : ''}`} steps={steps} onClose={onClose}
    foot={<><button className="btn pri" type="button" aria-disabled={ok ? undefined : true} onClick={save}><I n="i-check" />{wz.mode === 'edit' ? 'ذخیره‌ی تغییرها' : 'افزودن به صفحه'}</button><button className="btn gh" type="button" onClick={() => setWz((w) => ({ ...w, step: 1 }))}><I n="i-back" />قبلی</button></>}>
    {body}{genErr}
  </Modal>;
}

/* ---------- header (admin only) ---------- */
function HeaderModal({ st, onClose, onSaved }: { st: St; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(st.page.name); const [intro, setIntro] = useState(st.page.intro);
  const [logo, setLogo] = useState<Lg>(st.page.logo.kind === 'upload' ? { kind: 'upload', id: st.page.logo.id } : { kind: 'builtin', key: 'nafis' });
  const [up, setUp] = useState<Up | undefined>(); const [err, setErr] = useState<{ field?: string; msg: string } | null>(null); const [busy, setBusy] = useState(false);
  const nl = charLen(name.trim()), il = charLen(intro.trim());
  const ok = nl > 0 && nl <= 30 && il <= 80 && !busy && up?.state !== 'busy';
  const pick = () => pickFile(async (f) => { const keep = logo.kind === 'upload' ? 'آپلودشده' : LN.nafis; setUp({ state: 'busy', file: f.name, kb: Math.ceil(f.size / 1024) }); const r = await uploadLogo(f, keep); setUp(r.up); if (r.id) setLogo({ kind: 'upload', id: r.id }); });
  const save = async () => {
    if (!ok) return; setBusy(true); setErr(null);
    try { await req('/link-page/header', { method: 'PUT', body: JSON.stringify({ name: name.trim(), intro: intro.trim(), logoId: logo.kind === 'upload' ? logo.id : st.builtinLogos.find((x) => x.key === 'nafis')?.id }) }); onSaved(); }
    catch (e) { const he = e as HttpErr; setErr({ field: he.field, msg: he.message }); setBusy(false); }
  };
  const fe = (f: string) => (err?.field === f ? <p className="ferr" role="alert"><I n="i-alert" />{err.msg}</p> : null);
  return <Modal cls="" title="سربرگ صفحه" sub="لوگو، نام و یک خط معرفی بالای صفحه؛ فقط مدیر سیستم" onClose={onClose}
    foot={<><button className="btn pri" type="button" aria-disabled={ok ? undefined : true} onClick={save}><I n="i-check" />ذخیره</button><button className="btn gh" type="button" onClick={onClose}>انصراف</button></>}>
    <div className="fld"><span className="flab">لوگوی سربرگ</span><div className="lgl" role="radiogroup" aria-label="لوگوی سربرگ"><LogoTile k="nafis" sel={logo.kind === 'builtin'} onSel={() => { setLogo({ kind: 'builtin', key: 'nafis' }); setUp(undefined); }} /><UploadTile sel={logo.kind === 'upload'} onClick={pick} /></div>
      {up ? <UpRow up={up} onPick={pick} onRemove={() => { setUp(undefined); setLogo({ kind: 'builtin', key: 'nafis' }); }} /> : null}{UPI}{fe('logo')}</div>
    <div className="fld"><label className="flab" htmlFor="hn">نام<span className="lcn">{fa(nl)} از ۳۰</span></label><input id="hn" className={`inp tx${err?.field === 'name' ? ' er' : ''}`} value={name} maxLength={30} onChange={(e) => setName(e.target.value)} />{fe('name')}</div>
    <div className="fld"><label className="flab" htmlFor="hi">معرفی یک‌خطی<span className="lcn">{fa(il)} از ۸۰</span></label><textarea id="hi" className="ta2" value={intro} maxLength={80} onChange={(e) => setIntro(e.target.value)} />
      {err?.field === 'intro' ? fe('intro') : <p className="hint">بدون نرخ، درصد یا آمار؛ همین یک خط زیر نام می‌آید.</p>}</div>
    <div className="fld"><span className="flab">آدرس صفحه</span><div className="bu ro2"><span className="k"><I n="i-lock" />مقصد ثابت</span><span className="v">nafisvam.com/links</span></div><p className="hint">فعلاً یک صفحه برای نفیس وام است؛ آدرس عوض نمی‌شود.</p></div>
    {err && !['name', 'intro', 'logo'].includes(err.field ?? '') ? <p className="ferr" role="alert"><I n="i-alert" />{err.msg}</p> : null}
  </Modal>;
}

function DeleteDialog({ l, onClose, onDelete, onHide }: { l: Link; onClose: () => void; onDelete: () => void; onHide: () => void }) {
  const ref = useModalFocus(true, onClose);
  return <div className="mx cfx" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}><div ref={ref} className="md cf" role="alertdialog" aria-modal="true" aria-labelledby="cft" aria-describedby="cfd">
    <div className="cfb"><div className="ci"><I n="i-trash" /></div><h2 id="cft">این لینک حذف شود؟</h2>
      <div className="cfr"><Logo r={l.logo} /><div><b>{l.title}</b><span className="u">{shown(l.url)}</span></div></div>
      <p id="cfd">از صفحه و از این فهرست پاک می‌شود و برنمی‌گردد. اگر فقط نمی‌خواهی دیده شود، مخفی‌اش کن؛ شمار کلیک‌ها هم می‌ماند.</p></div>
    <div className="mf"><button className="btn dng" type="button" onClick={onDelete}><I n="i-trash" />حذف لینک</button>{l.visible ? <button className="btn gh" type="button" onClick={onHide} data-autofocus><I n="i-eye-off" />مخفی کن</button> : null}<button className="btn lk" type="button" onClick={onClose} data-autofocus={l.visible ? undefined : true}>انصراف</button></div>
  </div></div>;
}

/* ---------- page ---------- */
export default function LinksAdmin() {
  const [me, setMe] = useState<Me | null | 'off'>(null);
  const [st, setSt] = useState<St | null>(null); const [err, setErr] = useState<string | null>(null);
  const [view, setView] = useState<'list' | 'pv'>('list');
  const [wz, setWzS] = useState<Wz | null>(null); const [hdr, setHdr] = useState(false); const [del, setDel] = useState<Link | null>(null);
  const [toast, setToast] = useState<{ text: string; undo?: () => void; k: number } | null>(null);
  const [order, setOrder] = useState<number[] | null>(null); const [drag, setDrag] = useState<{ id: number; kb: boolean } | null>(null); const [live, setLive] = useState('');
  const mainRef = useRef<HTMLDivElement>(null); const rowRefs = useRef(new Map<number, HTMLLIElement>()); const handleRefs = useRef(new Map<number, HTMLButtonElement>());
  const setWz = useCallback((f: (w: Wz) => Wz) => setWzS((w) => (w ? f(w) : w)), []);

  const load = useCallback(async () => { try { setSt(await req<St>('/link-page')); setErr(null); } catch (e) { setErr((e as Error).message); } }, []);
  useEffect(() => {
    req<Me>('/link-page/me').then((m) => { setMe(m); if (m.canManage) void load(); }).catch((e) => setMe((e as HttpErr).status === 404 ? 'off' : { enabled: true, canManage: false, canEditHeader: false }));
  }, [load]);
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(null), toast.undo ? 7000 : 4000); return () => clearTimeout(t); }, [toast]);
  const modalOpen = !!(wz || hdr || del);
  useEffect(() => { const m = mainRef.current; if (!m) return; if (modalOpen) m.setAttribute('inert', ''); else m.removeAttribute('inert'); }, [modalOpen]);
  const say = (text: string, undo?: () => void) => setToast({ text, undo, k: Date.now() });

  const links = useMemo(() => { if (!st) return []; if (!order) return st.links; const m = new Map(st.links.map((l) => [l.id, l])); return order.map((id) => m.get(id)!).filter(Boolean); }, [st, order]);

  if (me === 'off') return <NotFound />;
  if (!me) return <div className="lkp" />;
  if (!me.canManage) return <div className="lkp"><main className="pg"><section className="card na"><div className="ci"><I n="i-lock" cls="" /></div><b>این بخش برای مدیر سیستم و مدیر فروش است</b><p>در منوی «بیشتر» تو، صفحه‌ی لینک‌ها نیست. اگر لینکی باید عوض شود، به مدیر فروش بگو.</p><span className="muted">نقش تو: کارشناس فروش</span><a className="btn pri" href={`${base()}/`}>بازگشت به امروز</a></section></main></div>;
  if (!st) return <div className="lkp"><main className="pg">{err ? <p className="ferr" role="alert"><I n="i-alert" />{err}</p> : <p className="muted">در حال بارگذاری…</p>}</main></div>;

  const n = links.length, on = links.filter((l) => l.visible).length;
  const setVisible = async (l: Link, v: boolean, withToast = true) => {
    setSt((s) => s && { ...s, links: s.links.map((x) => (x.id === l.id ? { ...x, visible: v } : x)) });
    try { await req(`/link-page/links/${l.id}`, { method: 'PATCH', body: JSON.stringify({ visible: v }) }); if (!v && withToast) say(`${l.title} از صفحه برداشته شد؛ پاک نشد.`, () => { void setVisible(l, true, false); setToast(null); }); }
    catch (e) { say((e as Error).message); void load(); }
  };
  const commitOrder = async (ids: number[]) => {
    const before = st.links.map((l) => l.id); setOrder(null);
    if (ids.join() === before.join()) return;
    const m = new Map(st.links.map((l) => [l.id, l])); setSt({ ...st, links: ids.map((id) => m.get(id)!) });
    try { await req('/link-page/order', { method: 'PUT', body: JSON.stringify({ ids }) }); } catch (e) { say((e as Error).message); void load(); }
  };
  /* pointer drag (mouse + touch) on the handle */
  const onDown = (e: RPE<HTMLButtonElement>, id: number) => {
    if (e.button !== 0 || drag?.kb) return; e.preventDefault(); (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const ids = links.map((l) => l.id); let cur = ids; setOrder(ids); setDrag({ id, kb: false });
    const move = (ev: PointerEvent) => {
      const y = ev.clientY; let to = cur.indexOf(id);
      for (const [i, rid] of cur.entries()) { const r = rowRefs.current.get(rid)?.getBoundingClientRect(); if (!r) continue; if (y >= r.top && y <= r.bottom) { to = i; break; } }
      const from = cur.indexOf(id); if (to !== from) { const nx = cur.filter((x) => x !== id); nx.splice(to, 0, id); cur = nx; setOrder(nx); }
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); setDrag(null); void commitOrder(cur); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
  };
  /* keyboard: space picks up, ↑/↓ move, space/enter drops, Esc cancels */
  const onKey = (e: RKE<HTMLButtonElement>, l: Link) => {
    const ids = order ?? links.map((x) => x.id);
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      if (drag?.kb && drag.id === l.id) { setDrag(null); setLive(`${l.title}، جای ${fa(ids.indexOf(l.id) + 1)} از ${fa(n)}؛ ذخیره شد.`); void commitOrder(ids); }
      else { setOrder(ids); setDrag({ id: l.id, kb: true }); setLive(`${l.title} برداشته شد، جای ${fa(ids.indexOf(l.id) + 1)} از ${fa(n)}. با بالا و پایین جابه‌جا کن؛ با فاصله بگذار.`); }
    } else if (drag?.kb && drag.id === l.id && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault(); const i = ids.indexOf(l.id), j = e.key === 'ArrowUp' ? i - 1 : i + 1; if (j < 0 || j >= ids.length) return;
      const nx = [...ids]; [nx[i], nx[j]] = [nx[j], nx[i]]; setOrder(nx); setLive(`${l.title}، جای ${fa(j + 1)} از ${fa(n)}`);
      requestAnimationFrame(() => handleRefs.current.get(l.id)?.focus());
    } else if (e.key === 'Escape' && drag?.kb) { e.preventDefault(); setDrag(null); setOrder(null); setLive('جابه‌جایی لغو شد.'); }
  };
  const openAdd = () => setWzS({ mode: 'add', step: 1, type: 'ig', logo: { kind: 'builtin', key: 'ig' }, logoTouched: false, title: TY.ig.n, titleTouched: false, value: '' });
  const openEdit = (l: Link) => setWzS({ mode: 'edit', id: l.id, step: 2, type: l.type, logo: l.logo.kind === 'upload' ? { kind: 'upload', id: l.logo.id } : { kind: 'builtin', key: l.logo.key }, logoTouched: true, title: l.title, titleTouched: true, value: l.value, clicks: l.clicks, origTitle: l.title });
  const copy = async () => { try { await navigator.clipboard.writeText(PAGE_URL); say('آدرس صفحه کپی شد: nafisvam.com/links'); } catch { say('کپی نشد؛ آدرس را از کنار عنوان بردار: nafisvam.com/links'); } };
  const pub = links.filter((l) => l.visible);

  return <div className="lkp">
    <div ref={mainRef}><main className="pg">
      <div className="lkh"><h2>صفحه‌ی لینک‌ها</h2>
        <span className="adr"><span className="u">nafisvam.com/links</span><button className="ib" type="button" aria-label="کپی آدرس صفحه" onClick={copy}><I n="i-copy" /></button><a className="ib" href={PAGE_URL} target="_blank" rel="noopener noreferrer" aria-label="باز کردن صفحه در زبانه‌ی تازه"><I n="i-link" /></a></span>
        <span className="sp" />{n ? <button className="btn pri" type="button" onClick={openAdd}><I n="i-plus" />افزودن لینک</button> : null}</div>
      <div className="seg mseg" role="tablist" aria-label="نمایش"><button type="button" role="tab" aria-selected={view === 'list'} onClick={() => setView('list')}>فهرست لینک‌ها</button><button type="button" role="tab" aria-selected={view === 'pv'} onClick={() => setView('pv')}>پیش‌نمایش</button></div>
      <div className="lkg" data-v={view}><div className="lkm">
        <section className="card hdc" aria-label="سربرگ صفحه"><Avatar r={st.page.logo} /><div className="tx"><div className="k">سربرگ صفحه</div><b>{st.page.name}</b><p>{st.page.intro}</p></div>
          {st.canEditHeader ? <button className="btn gh sm" type="button" onClick={() => setHdr(true)}><I n="i-pen" />ویرایش سربرگ</button> : <span className="ro"><I n="i-lock" />سربرگ را فقط مدیر سیستم عوض می‌کند</span>}</section>
        {!n ? <section className="card empty" aria-label="لینک‌ها"><div className="eg" aria-hidden="true">{['nafis', 'wa', 'ig', 'tel'].map((k) => <Logo key={k} r={{ kind: 'builtin', key: k }} />)}</div>
          <b>هنوز لینکی روی صفحه نیست</b><p>اولین لینک را اضافه کن؛ مثلاً فرم درخواست وام یا واتساپ پشتیبانی. تا لینکی نباشد، صفحه فقط سربرگ و آدرس سایت را نشان می‌دهد.</p>
          <button className="btn pri" type="button" onClick={openAdd}><I n="i-plus" />افزودن اولین لینک</button></section>
          : <section className="card llc" aria-label="لینک‌ها">
            <div className="llh"><b>{fa(n)} لینک، {fa(on)} روی صفحه</b><span className="muted">کلیک‌ها در ۳۰ روز گذشته، {fmtDay(st.window.from, false)} تا {fmtDay(st.window.to, true)}</span></div>
            <p className="sr-only" role="status" aria-live="polite">{live}</p>
            <ul className="ll">{links.map((l, i) => {
              const dg = drag?.id === l.id;
              return <li key={l.id} ref={(el) => { if (el) rowRefs.current.set(l.id, el); else rowRefs.current.delete(l.id); }} className={`lr${l.visible ? '' : ' off'}${l.isNew ? ' new' : ''}${dg ? ' drag' : ''}`}>
                {dg ? <span className="dpos" aria-hidden="true">جای {fa(i + 1)} از {fa(n)}</span> : null}
                <button ref={(el) => { if (el) handleRefs.current.set(l.id, el); else handleRefs.current.delete(l.id); }} className="hd" type="button" style={{ touchAction: 'none' }} aria-label={`جابه‌جایی ${sq(l.title)}، جای ${fa(i + 1)} از ${fa(n)}`} aria-pressed={dg && drag?.kb ? true : undefined}
                  onPointerDown={(e) => onDown(e, l.id)} onKeyDown={(e) => onKey(e, l)} onBlur={() => { if (drag?.kb && drag.id === l.id) { setDrag(null); setOrder(null); } }}><I n="i-drag" /></button>
                <Logo r={l.logo} />
                <div className="tx"><b>{l.title}</b><span className="u">{shown(l.url)}</span>{l.isNew || l.type === 'lead' || !l.visible ? <span className="ltg">
                  {l.isNew ? <span className="chip s">تازه</span> : null}{l.type === 'lead' ? <span className="chip b"><I n="i-flag" />منبع سرنخ: صفحه لینک‌ها</span> : null}{!l.visible ? <span className="chip"><I n="i-eye-off" />مخفی، روی صفحه نیست</span> : null}</span> : null}</div>
                <div className="ck"><b>{fa(l.clicks)}</b>کلیک</div>
                <button className="lsw swl" type="button" role="switch" aria-checked={l.visible} aria-label={`نمایش ${sq(l.title)} روی صفحه`} onClick={() => void setVisible(l, !l.visible)}><span className="tr2" aria-hidden="true" /><span className="sl" aria-hidden="true">{l.visible ? 'روشن' : 'مخفی'}</span></button>
                <div className="ac"><button className="ib" type="button" aria-label={`ویرایش ${sq(l.title)}`} onClick={() => openEdit(l)}><I n="i-pen" /></button><button className="ib" type="button" aria-label={`حذف ${sq(l.title)}`} onClick={() => setDel(l)}><I n="i-trash" /></button></div>
              </li>; })}</ul>
            <p className="kbh2">برای عوض کردن ترتیب، دستگیره را بکش. با صفحه‌کلید: روی دستگیره فاصله، بعد بالا یا پایین. هر تغییر همان لحظه روی صفحه می‌رود.</p>
          </section>}
      </div>
        <aside className="pvw" aria-label="پیش‌نمایش زنده"><div className="pvh">پیش‌نمایش زنده<span className="live">همان چیزی که مشتری می‌بیند</span></div>
          <div className="phn2" aria-hidden="true"><div className="scr"><PubPage name={st.page.name} intro={st.page.intro} logo={st.page.logo} links={pub} /></div></div>
          <p className="pvn">لینک‌های مخفی در صفحه و پیش‌نمایش نیستند.</p></aside>
      </div>
    </main></div>
    {wz ? <Wizard st={st} wz={wz} setWz={setWz} onClose={() => setWzS(null)} onSaved={(title, mode) => { setWzS(null); void load(); say(mode === 'add' ? `${title} اضافه شد و روی صفحه است.` : `${title} ذخیره شد و همان لحظه روی صفحه است.`); }} /> : null}
    {hdr ? <HeaderModal st={st} onClose={() => setHdr(false)} onSaved={() => { setHdr(false); void load(); say('سربرگ ذخیره شد و روی صفحه است.'); }} /> : null}
    {del ? <DeleteDialog l={del} onClose={() => setDel(null)} onHide={() => { const l = del; setDel(null); void setVisible(l, false); }}
      onDelete={async () => { const l = del; setDel(null); try { await req(`/link-page/links/${l.id}`, { method: 'DELETE' }); say(`${l.title} حذف شد.`); } catch (e) { say((e as Error).message); } void load(); }} /> : null}
    <div className={`toast${toast ? ' on' : ''}`} role="status" aria-live="polite">{toast ? <><I n="i-check" /><span>{toast.text}</span>{toast.undo ? <button className="btn lk sm" type="button" style={{ color: 'var(--nf-gold-300)' }} onClick={toast.undo}>برگرداندن</button> : null}</> : null}</div>
  </div>;
}
