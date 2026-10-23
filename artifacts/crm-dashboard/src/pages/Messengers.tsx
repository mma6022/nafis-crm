import { useState } from 'react';
import { ExternalLink, RotateCw } from 'lucide-react';
import './messengers.css';

/**
 * Messengers page (/messengers): Telegram / WhatsApp / Bale web clients embedded in iframes.
 * Ported from the hot-patched production bundle (index-987beb8b7b.js, `__MessengersPage`).
 * All traffic goes through nafisvam-social-proxy at `/_social/enter?svc=<tg|wa|bale>` (same-origin, nginx).
 * Behaviour is kept identical: frames are mounted lazily on first open and kept alive while switching tabs;
 * "reload" bumps a per-service nonce (`&r=<n>`) which remounts only the active frame.
 */
type ServiceKey = 'tg' | 'wa' | 'bale';

const SERVICES: { k: ServiceKey; l: string }[] = [
  { k: 'tg', l: 'تلگرام' },
  { k: 'wa', l: 'واتس‌اپ' },
  { k: 'bale', l: 'بله' },
];

const FRAME_ALLOW = 'clipboard-read; clipboard-write; microphone; camera; notifications; fullscreen; autoplay; display-capture';

export const socialEnterUrl = (svc: ServiceKey, nonce = 0) => `/_social/enter?svc=${svc}${nonce ? `&r=${nonce}` : ''}`;

export default function MessengersPage() {
  const [active, setActive] = useState<ServiceKey>('tg');
  const [opened, setOpened] = useState<Partial<Record<ServiceKey, boolean>>>({ tg: true });
  const [nonce, setNonce] = useState<Partial<Record<ServiceKey, number>>>({});

  const pick = (k: ServiceKey) => {
    setActive(k);
    setOpened(o => ({ ...o, [k]: true }));
  };

  return (
    <div className="msgr-page" data-testid="page-messengers">
      <div className="msgr-bar">
        <div className="msgr-tabs" role="tablist" aria-label="پیام‌رسان‌ها">
          {SERVICES.map(t => (
            <button
              key={t.k}
              type="button"
              role="tab"
              aria-selected={active === t.k}
              className={`msgr-tab${active === t.k ? ' active' : ''}`}
              onClick={() => pick(t.k)}
              data-testid={`tab-messenger-${t.k}`}
            >
              {t.l}
            </button>
          ))}
        </div>
        <div className="msgr-actions">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => setNonce(n => ({ ...n, [active]: (n[active] || 0) + 1 }))}
            data-testid="button-messenger-reload"
          >
            <RotateCw size={16} aria-hidden /> بارگذاری دوباره
          </button>
          <a className="btn btn-ghost" href={socialEnterUrl(active)} target="_blank" rel="noopener" data-testid="link-messenger-newtab">
            <ExternalLink size={16} aria-hidden /> باز کردن در تب جدید
          </a>
        </div>
      </div>
      <p className="msgr-note">
        ترافیک این پنجره‌ها از طریق سرور نفیس‌وام عبور می‌کند و مستقیم به سرویس پیام‌رسان نمی‌رود. هر کاربر نشست خودش را در مرورگر خودش دارد.
      </p>
      <div className="msgr-frames">
        {SERVICES.map(t => opened[t.k] ? (
          <iframe
            key={`${t.k}${nonce[t.k] || 0}`}
            title={t.l}
            className="msgr-frame"
            style={{ display: active === t.k ? 'block' : 'none' }}
            src={socialEnterUrl(t.k, nonce[t.k] || 0)}
            allow={FRAME_ALLOW}
            data-testid={`frame-messenger-${t.k}`}
          />
        ) : null)}
      </div>
    </div>
  );
}
