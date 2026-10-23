import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Phone, X } from 'lucide-react';
import { CHANNELS, EXPERT_HOURS, pickerRows, type ExpertChannel } from './sales-experts';

/* Messenger glyphs (lucide has no brand icons). currentColor, 24×24. */
const WaIcon = (p: { className?: string }) => <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor" aria-hidden="true" {...p}><path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2Zm0 18.2c-1.5 0-3-.4-4.3-1.2l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2Zm4.5-6.1c-.2-.1-1.5-.7-1.7-.8-.2-.1-.4-.1-.6.1l-.8 1c-.1.2-.3.2-.5.1a6.7 6.7 0 0 1-3.3-2.9c-.3-.4.3-.4.7-1.3.1-.2 0-.3 0-.4l-.8-1.8c-.2-.5-.4-.4-.6-.4h-.5c-.2 0-.4.1-.7.3-.2.3-.9.9-.9 2.2s.9 2.5 1 2.7c.1.2 1.8 2.8 4.4 3.9 1.6.7 2.3.8 3.1.6.5-.1 1.5-.6 1.7-1.2.2-.6.2-1.1.2-1.2-.1-.1-.3-.2-.5-.3Z"/></svg>;
const TgIcon = (p: { className?: string }) => <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor" aria-hidden="true" {...p}><path d="M21.9 4.3 18.7 19.4c-.2 1-.9 1.3-1.7.8l-4.8-3.6-2.3 2.2c-.3.3-.5.5-1 .5l.3-4.9 8.9-8c.4-.3-.1-.5-.6-.2L6.5 13.1 1.8 11.6c-1-.3-1-1 .2-1.5l18.5-7.1c.9-.3 1.6.2 1.4 1.3Z"/></svg>;
const BaleIcon = (p: { className?: string }) => <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...p}><path d="M12 3a9 9 0 1 1-7.8 13.5L3 21l4.6-1.2A9 9 0 0 0 12 21"/><path d="M8.5 9.5v5a2.5 2.5 0 0 0 5 0 2.5 2.5 0 0 0-2.5-2.5H8.5"/></svg>;
export function ChannelIcon({ channel, className = 'nfp-i' }: { channel: ExpertChannel; className?: string }) {
  if (channel === 'whatsapp') return <WaIcon className={className} />;
  if (channel === 'telegram') return <TgIcon className={className} />;
  if (channel === 'bale') return <BaleIcon className={className} />;
  return <Phone className={className} aria-hidden="true" />;
}

const initial = (name: string) => name.replace(/^(خانم|آقای)\s+/, '').trim().charAt(0);
const DESKTOP = '(min-width: 768px)';
type Assigned = { name?: string | null; mobile?: string | null } | null | undefined;

/**
 * Expert picker (nafis-design/CONTACT-EXPERTS.md). Radix Dialog: aria-modal, focus trap, Escape and
 * outside-click close, focus returns to the trigger; initial focus on the close button.
 * <768px: bottom sheet. ≥768px: 360px popover anchored under the trigger (above if no room), clamped to the
 * viewport and re-positioned on scroll/resize. Rendered into the nearest .nfp root so it uses portal tokens.
 * Rows without a valid link are hidden; if none remain the trigger itself is not rendered.
 */
export function ExpertPicker({ channel = 'call', trigger, testId = 'expert-picker', assigned, caseNo }: {
  channel?: ExpertChannel; trigger: ReactNode; testId?: string; assigned?: Assigned; caseNo?: string | number | null;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<CSSProperties | undefined>();
  const anchor = useRef<HTMLElement | null>(null);
  const panel = useRef<HTMLDivElement | null>(null);
  const closeBtn = useRef<HTMLButtonElement | null>(null);
  const rows = pickerRows(channel, assigned, caseNo);
  const ch = CHANNELS[channel];

  const place = useCallback(() => {
    if (!anchor.current || !panel.current || !window.matchMedia(DESKTOP).matches) { setPos(undefined); return; }
    const r = anchor.current.getBoundingClientRect(); const h = panel.current.offsetHeight; const w = Math.min(360, window.innerWidth - 16);
    const vw = document.documentElement.clientWidth; const vh = window.innerHeight; const gap = 8;
    let top = r.bottom + gap; if (top + h > vh - 8 && r.top - gap - h >= 8) top = r.top - gap - h;
    top = Math.max(8, Math.min(top, vh - h - 8));
    let left = r.left + r.width / 2 - w / 2; left = Math.max(8, Math.min(left, vw - w - 8));
    setPos({ top, left, width: w });
  }, []);
  useLayoutEffect(() => {
    if (!open) { setPos(undefined); return; }
    let raf = 0; const tick = (n: number) => { if (panel.current) place(); else if (n < 10) raf = requestAnimationFrame(() => tick(n + 1)); };
    tick(0); return () => cancelAnimationFrame(raf);
  }, [open, place]);
  useEffect(() => {
    if (!open) return;
    const on = () => place();
    window.addEventListener('resize', on); window.addEventListener('scroll', on, true);
    return () => { window.removeEventListener('resize', on); window.removeEventListener('scroll', on, true); };
  }, [open, place]);

  if (!rows.length) return null;
  return <Dialog.Root open={open} onOpenChange={setOpen}>
    <Dialog.Trigger asChild onClick={e => { anchor.current = e.currentTarget as HTMLElement; }}>{trigger}</Dialog.Trigger>
    <Dialog.Portal container={typeof document !== 'undefined' ? document.querySelector<HTMLElement>('.nfp') : undefined}>
      <Dialog.Overlay className="nfp-xp-overlay" />
      <Dialog.Content ref={panel} className={`nfp-xp${pos ? ' nfp-xp-pop' : ''}`} style={pos} dir="rtl" aria-modal="true"
        data-testid={testId} aria-describedby={`${testId}-via`}
        onOpenAutoFocus={e => { e.preventDefault(); closeBtn.current?.focus(); }}>
        <div className="nfp-xp-grip" aria-hidden="true" />
        <div className="nfp-xp-head">
          <span className={`nfp-xp-chip nfp-xp-${channel}`} aria-hidden="true"><ChannelIcon channel={channel} /></span>
          <div className="nfp-xp-ht"><Dialog.Title className="nfp-xp-title">با کدام کارشناس تماس می‌گیرید؟</Dialog.Title>
            <Dialog.Description id={`${testId}-via`} className="nfp-xp-desc">از طریق {ch.via}</Dialog.Description></div>
          <Dialog.Close ref={closeBtn} className="nfp-xp-x" aria-label="بستن" data-testid={`${testId}-close`}><X size={20} aria-hidden="true" /></Dialog.Close>
        </div>
        <ul className="nfp-xp-list">{rows.map(e => <li key={(e.assigned ? 'a-' : '') + e.mobile}>
          <a className={`nfp-xp-row${e.assigned ? ' nfp-xp-mine' : ''}`} href={e.href} onClick={() => setOpen(false)}
            {...(ch.external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
            aria-label={`${ch.act} با ${e.name}، ${e.role}${ch.external ? ' (در پنجره‌ی جدید)' : ''}`} data-testid={`${testId}-${e.assigned ? 'assigned' : e.mobile}`}>
            <span className="nfp-xp-av" aria-hidden="true">{initial(e.name)}</span>
            <span className="nfp-xp-who"><b>{e.name}</b><small>{e.role}</small></span>
            <span className={`nfp-xp-act nfp-xp-${channel}`} aria-hidden="true"><ChannelIcon channel={channel} className="nfp-i nfp-s" />{ch.act}</span>
          </a></li>)}</ul>
        <p className="nfp-xp-hours" data-testid={`${testId}-hours`}>{EXPERT_HOURS}</p>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}

/** Button that opens the picker; `label` omitted → icon-only (aria-label). Not rendered if the channel has no valid link. */
export function ExpertPickerButton({ channel = 'call', label, className = 'nf-btn nf-btn--secondary', ariaLabel, testId, assigned, caseNo }: {
  channel?: ExpertChannel; label?: string; className?: string; ariaLabel?: string; testId?: string; assigned?: Assigned; caseNo?: string | number | null;
}) {
  return <ExpertPicker channel={channel} assigned={assigned} caseNo={caseNo} testId={testId ? `${testId}-picker` : undefined}
    trigger={<button type="button" className={className} aria-label={ariaLabel ?? label ?? (channel === 'call' ? 'تماس با کارشناس فروش' : `پیام در ${CHANNELS[channel].via}`)} aria-haspopup="dialog" data-testid={testId}>
      <ChannelIcon channel={channel} className={`nfp-i${label ? ' nfp-s' : ''}`} />{label}</button>} />;
}
