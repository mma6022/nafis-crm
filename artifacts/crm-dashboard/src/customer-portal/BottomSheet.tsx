import type { ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';

/** Accessible bottom sheet (Radix: focus trap, Escape/backdrop close, focus restore). locked blocks dismissal. */
export function BottomSheet({ open, onClose, locked, title, description, children, testId }: {
  open: boolean; onClose: () => void; locked?: boolean; title: string; description: string; children: ReactNode; testId: string;
}) {
  const block = (e: Event) => { if (locked) e.preventDefault(); };
  return <Dialog.Root open={open} onOpenChange={next => { if (!next && !locked) onClose(); }}>
    <Dialog.Portal container={typeof document !== 'undefined' ? document.querySelector<HTMLElement>('.cp') : undefined}>
      <Dialog.Overlay className="cp-sheet-overlay" />
      <Dialog.Content id={testId} className="cp-sheet" dir="rtl" data-testid={testId} onEscapeKeyDown={block} onPointerDownOutside={block} onInteractOutside={block}
        onCloseAutoFocus={event => {
          const trigger = document.querySelector<HTMLButtonElement>(`button[aria-controls="${testId}"]`);
          const target = trigger?.disabled ? trigger.parentElement?.querySelector<HTMLButtonElement>('button:not([disabled])') : trigger;
          if (target) { event.preventDefault(); target.focus(); }
        }}>
        <div className="cp-sheet-grip" aria-hidden="true" />
        <div className="cp-sheet-head"><div><Dialog.Title>{title}</Dialog.Title><Dialog.Description>{description}</Dialog.Description></div>
          <Dialog.Close className="cp-sheet-x" disabled={locked} aria-label="بستن" data-testid={`${testId}-close`}><X size={18} /></Dialog.Close></div>
        {children}
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
