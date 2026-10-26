import { asColor } from './api';

export type AvState = 'idle' | 'think' | 'attn' | 'speak' | 'dnd' | 'off';
/** Robot-face avatar from the smart-assistant design (parts/sa.js av()).
 *  v5 `robot`: the floating head's always-on gentle motion (bob, antenna + hand wiggle); 'active' (unread / typing) moves a bit more.
 *  CSS keyframes on transform/opacity only; static under prefers-reduced-motion. */
export function AssistantAvatar({ slug, state = 'idle', size = 56, robot }: { slug: string; state?: AvState; size?: number; robot?: 'idle' | 'active' }) {
  return <span className={`nas-av st-${state}${robot ? ` rb rb-${robot}` : ''}`} style={{ ['--c' as string]: asColor(slug), ['--z' as string]: `${size}px` }} aria-hidden="true" data-robot={robot}>
    <span className="rg" />
    <svg viewBox="0 0 48 48">
      <circle cx="24" cy="24" r="24" fill={asColor(slug)} />
      <g className="bot">
        <g className="an"><path d="M24 6.5v5" stroke="#fff" strokeWidth="2" strokeLinecap="round" /><circle cx="24" cy="6" r="2.6" fill="#F5C24B" /></g>
        <rect x="10" y="13" width="28" height="22" rx="11" fill="#fff" />
        <g className="ey"><circle cx="18.5" cy="23" r="2.6" fill="#0B1450" /><circle cx="29.5" cy="23" r="2.6" fill="#0B1450" /></g>
        <path className="mo" d="M19.5 28.5q4.5 3.5 9 0" stroke="#0B1450" strokeWidth="2.2" fill="none" strokeLinecap="round" />
        <ellipse className="mo2" cx="24" cy="29.5" rx="3.2" ry="2.4" fill="#0B1450" />
        <circle cx="14" cy="28" r="1.8" fill="#F8B4B4" opacity=".75" /><circle cx="34" cy="28" r="1.8" fill="#F8B4B4" opacity=".75" />
      </g>
      {robot ? <g className="hd"><path d="M33.5 36.5q4.5-.5 6-5" stroke="#fff" strokeWidth="2.4" fill="none" strokeLinecap="round" /><circle cx="40" cy="30" r="2.7" fill="#fff" /></g> : null}
    </svg>
  </span>;
}
