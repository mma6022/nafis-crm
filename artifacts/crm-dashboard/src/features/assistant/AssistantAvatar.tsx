import { asColor, type AsKind } from './api';

export type AvState = 'idle' | 'think' | 'attn' | 'speak' | 'dnd' | 'off';
/** Robot-face avatar from the smart-assistant design (parts/sa.js av()).
 *  v5 `robot`: the floating head's always-on gentle motion (bob, antenna + hand wiggle); 'active' (unread / typing) moves a bit more.
 *  v8 `kind='manager'` («احمد | مدیر فروش», design آرمیتا manager-assistant/HANDOFF.md): gold rising-chart antenna, level brows,
 *  white collar + gold tie, calmer smile and slower motion (4s). Same states; `typing` adds the talking mouth.
 *  CSS keyframes on transform/opacity only; static under prefers-reduced-motion. */
export function AssistantAvatar({ slug, state = 'idle', size = 56, robot, kind, typing }: { slug: string; state?: AvState; size?: number; robot?: 'idle' | 'active'; kind?: AsKind; typing?: boolean }) {
  const mgr = kind === 'manager';
  return <span className={`nas-av st-${state}${robot ? ` rb rb-${robot}` : ''}${mgr ? ' mgr' : ''}${mgr && typing ? ' mgr-ty' : ''}`} style={{ ['--c' as string]: asColor(slug), ['--z' as string]: `${size}px` }} aria-hidden="true" data-robot={robot} data-kind={mgr ? 'manager' : undefined}>
    <span className="rg" />
    <svg viewBox="0 0 48 48">
      <circle cx="24" cy="24" r="24" fill={asColor(slug)} />
      {mgr ? <g className="bot">
        <g className="an"><path d="M24 8.6v4.6" stroke="#fff" strokeWidth="2" strokeLinecap="round" />
          <rect x="19.6" y="7.4" width="8.8" height="1.6" rx=".8" fill="#F3BD47" />
          <rect className="b b1" x="20.2" y="4.6" width="2.1" height="2.8" rx=".7" fill="#F3BD47" />
          <rect className="b b2" x="22.95" y="2.9" width="2.1" height="4.5" rx=".7" fill="#F3BD47" />
          <rect className="b b3" x="25.7" y="1.2" width="2.1" height="6.2" rx=".7" fill="#F3BD47" /></g>
        <rect x="10" y="13" width="28" height="22" rx="11" fill="#fff" />
        <path className="br" d="M15.7 18.7q2.6-1.1 5.2-.1M32.3 18.7q-2.6-1.1-5.2-.1" stroke="#0B1450" strokeWidth="1.8" strokeLinecap="round" fill="none" />
        <g className="ey"><circle cx="18.5" cy="23.2" r="2.5" fill="#0B1450" /><circle cx="29.5" cy="23.2" r="2.5" fill="#0B1450" /><circle cx="19.3" cy="22.4" r=".7" fill="#fff" /><circle cx="30.3" cy="22.4" r=".7" fill="#fff" /></g>
        <path className="mo" d="M20 28.6q4 2.8 8 0" stroke="#0B1450" strokeWidth="2.2" fill="none" strokeLinecap="round" />
        <ellipse className="mo2" cx="24" cy="29.4" rx="3" ry="2.1" fill="#0B1450" />
        <circle cx="14" cy="28" r="1.6" fill="#F8B4B4" opacity=".5" /><circle cx="34" cy="28" r="1.6" fill="#F8B4B4" opacity=".5" />
        <g className="tie"><path d="M17.6 35.3L24 38.6 21 42.2zM30.4 35.3L24 38.6 27 42.2z" fill="#fff" />
          <path d="M22.3 37.6h3.4l-.6 2.1h-2.2z" fill="#F3BD47" /><path d="M22.6 39.9h2.8l1.1 5.1-2.5 2.1-2.5-2.1z" fill="#F3BD47" />
          <path d="M23.1 40.6h1.8" stroke="#8A6212" strokeWidth=".6" strokeLinecap="round" opacity=".6" /></g>
      </g> : <g className="bot">
        <g className="an"><path d="M24 6.5v5" stroke="#fff" strokeWidth="2" strokeLinecap="round" /><circle cx="24" cy="6" r="2.6" fill="#F5C24B" /></g>
        <rect x="10" y="13" width="28" height="22" rx="11" fill="#fff" />
        <g className="ey"><circle cx="18.5" cy="23" r="2.6" fill="#0B1450" /><circle cx="29.5" cy="23" r="2.6" fill="#0B1450" /></g>
        <path className="mo" d="M19.5 28.5q4.5 3.5 9 0" stroke="#0B1450" strokeWidth="2.2" fill="none" strokeLinecap="round" />
        <ellipse className="mo2" cx="24" cy="29.5" rx="3.2" ry="2.4" fill="#0B1450" />
        <circle cx="14" cy="28" r="1.8" fill="#F8B4B4" opacity=".75" /><circle cx="34" cy="28" r="1.8" fill="#F8B4B4" opacity=".75" />
      </g>}
      {robot ? <g className="hd"><path d="M33.5 36.5q4.5-.5 6-5" stroke="#fff" strokeWidth="2.4" fill="none" strokeLinecap="round" /><circle cx="40" cy="30" r="2.7" fill="#fff" /></g> : null}
    </svg>
  </span>;
}
