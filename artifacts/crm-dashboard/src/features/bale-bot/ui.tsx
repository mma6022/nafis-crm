/* bale v1.1: small shared pieces (icons, avatars, phone, id, toast, modal shells). */
import { useEffect, useState, type ReactNode } from 'react';
import { BB_GLYPHS } from './glyphs';
import { fd, fa } from './api';

export function I({ n, c = '' }: { n: string; c?: string }) {
  return <svg className={`i ${c}`} viewBox="0 0 24 24" aria-hidden="true" dangerouslySetInnerHTML={{ __html: BB_GLYPHS[n] ?? '' }} />;
}
const AV = ['c1', 'c2', 'c3', 'c4', 'c5'];
export function Ava({ name, seed, cls = '' }: { name: string; seed: number; cls?: string }) {
  const a = (name.trim()[0] ?? '؟').toUpperCase();
  return <span className={`ava ${AV[Math.abs(seed) % AV.length]} ${cls}`} aria-hidden="true">{a}</span>;
}
export const isLatin = (s: string) => /^[\x20-\x7e]+$/.test(s.trim());
export function Nm({ name }: { name: string }) { return <span className="nm" dir={isLatin(name) ? 'ltr' : undefined}>{name}</span>; }
export function copyText(v: string, toast: (t: string) => void) { try { void navigator.clipboard?.writeText(v); } catch { /* ignore */ } toast('کپی شد'); }
export function Cid({ id, toast }: { id: number; toast: (t: string) => void }) {
  return <button className="cid" type="button" aria-label={`شناسه‌ی مشتری ${fd(id)}، کپی`} onClick={(e) => { e.stopPropagation(); copyText(`#${id}`, toast); }}>#{fd(id)}</button>;
}
export function Ph({ phone, big, toast }: { phone: string; big?: boolean; toast: (t: string) => void }) {
  const f = fd(phone);
  return <span className={`ph${big ? ' big' : ''}`}><a className="phn" href={`tel:${phone}`} dir="ltr">{f}</a>
    <button className="phc" type="button" aria-label={`کپی شماره‌ی ${f}`} onClick={(e) => { e.stopPropagation(); copyText(phone, toast); }}><I n="copy" />{big ? <span>کپی</span> : null}</button></span>;
}
export const Uname = ({ u }: { u: string }) => <span className="u" dir="ltr">@{u}</span>;
/** Internal-only label for a typed (not shared) mobile — decision (a). */
export const Unverified = () => <span className="chip uv" title="شماره را کارشناس تایپ کرده؛ با اشتراک شماره‌ی خود مشتری تأیید نشده است"><I n="alert" />تأییدنشده</span>;

export function useToast() {
  const [t, setT] = useState<string | null>(null);
  useEffect(() => { if (!t) return; const h = setTimeout(() => setT(null), 4000); return () => clearTimeout(h); }, [t]);
  return { toast: setT, node: t ? <div className="toast on" role="status"><I n="check" /><span>{t}</span></div> : null };
}
export function Steps({ labels, s, err, onBack }: { labels: string[]; s: number; err?: boolean; onBack?: (n: number) => void }) {
  return <ol className="wst" aria-label="مراحل">{labels.map((l, i) => {
    const n = i + 1, dn = n < s, cur = n === s, er = cur && err;
    const inner = dn && onBack ? <a href="#" onClick={(e) => { e.preventDefault(); onBack(n); }} aria-label={`مرحله‌ی ${fa(n)}، ${l}، انجام شد؛ برای عوض کردن بزن`}><b><I n="check" /></b><span className="l">{l}</span></a>
      : <><b>{dn ? <I n="check" /> : er ? <I n="alert" /> : fa(n)}</b><span className="l">{l}</span></>;
    return [i ? <li key={`b${i}`} className={`bar${dn || cur ? ' on' : ''}`} aria-hidden="true" /> : null,
      <li key={l} className={`${dn ? 'dn' : ''}${er ? ' er' : ''}`} aria-current={cur ? 'step' : undefined}>{inner}</li>];
  })}</ol>;
}
/* «مزاحم نشو» for Bale forms: in-flow under the modal header (not fixed; scrolls with the form). The CRM-wide DND pill/bar
   skips anything inside [data-bbdnd] — see AssistantDock useForeignOverlay. «خاموش کن» hides it for this session only. */
let dndOff = false;
function DndBar() {
  const [off, setOff] = useState(dndOff);
  if (off) return null;
  return <div className="dnd bdnd" role="status"><I n="moon" /><span>مزاحم نشو تا این فرم باز است</span><button className="btn" type="button" onClick={() => { dndOff = true; setOff(true); }}>خاموش کن</button></div>;
}
export function Modal({ cls = '', title, sub, steps, onClose, children, foot }: { cls?: string; title: string; sub: ReactNode; steps?: ReactNode; onClose: () => void; children: ReactNode; foot: ReactNode }) {
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [onClose]);
  return <div className="mx" data-bbdnd=""><div className={`md ${cls}`} role="dialog" aria-modal="true" aria-labelledby="mdt">
    <div className="mh"><div className="t"><h2 id="mdt">{title}</h2><p>{sub}</p>{steps}</div><button className="ib" type="button" onClick={onClose} aria-label="بستن"><I n="x" /></button></div>
    <div className="mb"><DndBar />{children}</div><div className="mf">{foot}</div></div></div>;
}
export function Confirm({ title, items, foot, ic = 'alert' }: { title: string; items: string[]; foot: ReactNode; ic?: string }) {
  return <div className="mx cfx" data-bbdnd=""><div className="md cf" role="alertdialog" aria-modal="true" aria-labelledby="cft" aria-describedby="cfd">
    <div className="cfb"><div className="ci"><I n={ic} /></div><h2 id="cft">{title}</h2><ul id="cfd">{items.map((t) => <li key={t}>{t}</li>)}</ul></div><div className="mf">{foot}</div></div></div>;
}

/** Persian digits for a phone-like or #id run. Stored values stay Latin 09… */
const PHONE_OR_ID = /(?:#\s*)?(?:\+98|0098|98|0)?9\d{8,9}|#\s*\d{2,}/g;
export function faPhoneString(text: string | null | undefined): string {
  if (!text) return text ?? '';
  return text.replace(PHONE_OR_ID, (m) => fd(m));
}
/** Render text with phone/id runs in Persian digits and dir=ltr. */
export function FaPhones({ text }: { text: string }) {
  const re = new RegExp(PHONE_OR_ID.source, 'g');
  const parts: ReactNode[] = [];
  let last = 0, m: RegExpExecArray | null, i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push(<bdi key={i++} className="bc-iso" dir="ltr">{fd(m[0])}</bdi>);
    last = m.index + m[0].length;
  }
  if (!parts.length) return <>{text}</>;
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}
