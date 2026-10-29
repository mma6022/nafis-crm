import { forwardRef, useCallback, useEffect, useLayoutEffect, useRef, type TextareaHTMLAttributes } from 'react';

/** NOTES-NOMAX: multi-line note field that grows with its content (min `minRows`, default 3); no maxLength. */
type Props = TextareaHTMLAttributes<HTMLTextAreaElement> & { minRows?: number };

export const AutoGrowTextarea = forwardRef<HTMLTextAreaElement, Props>(function AutoGrowTextarea({ minRows = 3, style, ...rest }, ref) {
  const inner = useRef<HTMLTextAreaElement | null>(null);
  const setRef = useCallback((el: HTMLTextAreaElement | null) => {
    inner.current = el;
    if (typeof ref === 'function') ref(el); else if (ref) (ref as { current: HTMLTextAreaElement | null }).current = el;
  }, [ref]);
  const fit = useCallback(() => {
    const el = inner.current; if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight + (el.offsetHeight - el.clientHeight)}px`;
  }, []);
  useLayoutEffect(fit, [rest.value, fit]);
  useEffect(() => {
    const el = inner.current; if (!el || typeof ResizeObserver === 'undefined') return;
    let w = el.clientWidth;
    const ro = new ResizeObserver(() => { if (el.clientWidth !== w) { w = el.clientWidth; fit(); } });
    ro.observe(el); return () => ro.disconnect();
  }, [fit]);
  return <textarea ref={setRef} rows={minRows} {...rest} style={{ resize: 'vertical', overflowY: 'hidden', width: '100%', boxSizing: 'border-box', lineHeight: 1.6, ...style }} />;
});
