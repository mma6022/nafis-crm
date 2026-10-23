/** Sprite icon (IconSprite.astro). `size` only when the mockup sets an inline size (default 22px from `svg.i`). */
export type SpriteIcon =
  | 'menu' | 'arrow' | 'back' | 'chev' | 'down' | 'check' | 'phone' | 'wa' | 'cash' | 'cart' | 'both' | 's' | 'm' | 'l'
  | 'clock' | 'coins' | 'online' | 'cal' | 'pin' | 'bolt' | 'user-x' | 'doc' | 'doc-x' | 'pen' | 'eye' | 'search'
  | 'chat' | 'shield' | 'layers' | 'alert' | 'lock' | 'x' | 'login' | 'book' | 'help' | 'user' | 'xl' | 'sun' | 'moon' | 'callback' | 'tg' | 'bale' | 'ig';

export function I({ name, size, className = '' }: { name: SpriteIcon; size?: number; className?: string }) {
  return (
    <svg className={`i ${className}`.trim()} aria-hidden="true" focusable="false" style={size ? { width: size, height: size } : undefined}>
      <use href={`#i-${name}`} />
    </svg>
  );
}
