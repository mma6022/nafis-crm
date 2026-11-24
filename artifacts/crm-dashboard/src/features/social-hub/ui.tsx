import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Check, Copy, X } from 'lucide-react';
import { fa } from './api';

/** «۰۹۱۲ ۰۰۰ ۰۰۸۳»: full number, Persian digits, LTR island. */
export const faPhone = (p: string) => { const d = String(p ?? '').replace(/\D/g, ''); const g = d.length === 11 ? `${d.slice(0, 4)} ${d.slice(4, 7)} ${d.slice(7)}` : d; return fa(g); };
export function copyText(t: string, done?: () => void) { void navigator.clipboard?.writeText(t).then(() => done?.()).catch(() => undefined); }
export function PhoneNum({ p, big, copy = true, testId }: { p: string; big?: boolean; copy?: boolean; testId?: string }) {
  const [ok, setOk] = useState(false);
  return <span className={`sh-ph${big ? ' big' : ''}`} data-testid={testId}><bdi>{faPhone(p)}</bdi>
    {copy ? <button type="button" className="sh-ib" aria-label="کپی شماره" onClick={() => copyText(p, () => { setOk(true); window.setTimeout(() => setOk(false), 1500); })}>{ok ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}</button> : null}</span>;
}
export function IdBadge({ id }: { id: number }) {
  const [ok, setOk] = useState(false);
  return <span role="button" tabIndex={0} className="sh-idb" aria-label="کپی شناسه مشتری" onClick={(e) => { e.stopPropagation(); copyText(String(id), () => { setOk(true); window.setTimeout(() => setOk(false), 1200); }); }}
    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); copyText(String(id)); } }}>{ok ? 'کپی شد' : `#${fa(id)}`}</span>;
}
export const Name = ({ name, id }: { name: string; id: number }) => <span className="sh-nm"><b>{name}</b><IdBadge id={id} /></span>;
export function NumList({ primary, extras, copy = false }: { primary: string; extras: string[]; copy?: boolean }) {
  return <div className="sh-nlist">
    <div className="sh-nrow"><span className="sh-lbl">شمارهٔ اصلی</span><PhoneNum p={primary} copy={copy} /></div>
    {extras.map((n, i) => <div key={n} className="sh-nrow"><span className="sh-lbl">{extras.length > 1 ? `شمارهٔ اضافه ${fa(i + 1)}` : 'شمارهٔ اضافه'}</span><PhoneNum p={n} copy={copy} /></div>)}
  </div>;
}
export const Switch = ({ on, label, onChange, disabled, testId }: { on: boolean; label: string; onChange?: (v: boolean) => void; disabled?: boolean; testId?: string }) =>
  <button type="button" role="switch" aria-checked={on} className={`sh-sw${on ? ' on' : ''}`} disabled={disabled} onClick={() => onChange?.(!on)} data-testid={testId}><i />{label}</button>;
export const CheckBox = ({ on, label, onChange, testId }: { on: boolean; label: string; onChange?: (v: boolean) => void; testId?: string }) =>
  <button type="button" role="checkbox" aria-checked={on} className={`sh-cb${on ? ' on' : ''}`} onClick={() => onChange?.(!on)} data-testid={testId}><i><Check aria-hidden="true" /></i>{label}</button>;
export const Radio = ({ on, title, sub, right, onClick, disabled, testId }: { on: boolean; title: string; sub?: string; right?: ReactNode; onClick?: () => void; disabled?: boolean; testId?: string }) =>
  <button type="button" role="radio" aria-checked={on} className={`sh-rd${on ? ' on' : ''}`} onClick={onClick} disabled={disabled} data-testid={testId}><i /><span className="rb"><b>{title}</b>{sub ? <span>{sub}</span> : null}</span>{right}</button>;

export function Wizard({ title, steps, cur, children, foot, onClose, short, testId }: { title: string; steps?: string[]; cur?: number; children: ReactNode; foot: ReactNode; onClose: () => void; short?: boolean; testId?: string }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { const prev = document.activeElement as HTMLElement | null; box.current?.querySelector<HTMLElement>('button')?.focus(); return () => prev?.focus?.(); }, []);
  return createPortal(<div className="sh sh-ov" onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }} data-testid={testId ? `${testId}-wrap` : undefined}>
    <div className={`sh-wz${short ? ' short' : ''}`} role="dialog" aria-modal="true" aria-label={title} ref={box} data-testid={testId}>
      <div className="sh-wz-h"><h2 className="sh-h3">{title}</h2><button type="button" className="sh-ib" aria-label="بستن" onClick={onClose}><X aria-hidden="true" /></button></div>
      {steps?.length ? <ol className="sh-steps" aria-label={`گام ${fa((cur ?? 0) + 1)} از ${fa(steps.length)}`} style={{ listStyle: 'none', margin: 0 }}>
        {steps.map((s, i) => <li key={s} style={{ display: 'contents' }}><span className={`sh-stp${i === cur ? ' on' : i < (cur ?? 0) ? ' done' : ''}`} aria-current={i === cur ? 'step' : undefined}><b>{i < (cur ?? 0) ? <Check aria-hidden="true" /> : fa(i + 1)}</b><span>{s}</span></span>{i < steps.length - 1 ? <i className="sh-stl" aria-hidden="true" /> : null}</li>)}
      </ol> : null}
      <div className="sh-wz-b">{children}</div>
      <div className="sh-wz-f">{foot}</div>
    </div></div>, document.body);
}
export function useShToast() {
  const [t, setT] = useState('');
  useEffect(() => { if (!t) return; const h = window.setTimeout(() => setT(''), 3000); return () => window.clearTimeout(h); }, [t]);
  return { toast: setT, node: t ? createPortal(<div className="sh sh-toast" role="status" data-testid="sh-toast"><Check aria-hidden="true" />{t}</div>, document.body) : null };
}
