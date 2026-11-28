/** t992: Enter sends from the Bale inbox composer; Shift+Enter inserts a newline.
 *  On touch / coarse pointers, plain Enter stays a newline (the send button is used).
 *  IME composition (isComposing / keyCode 229) is left alone. */
export type EnterKey = {
  key: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  isComposing?: boolean;
  keyCode?: number;
  nativeEvent?: { isComposing?: boolean; keyCode?: number };
};

export type ComposerEnterAction = 'send' | 'newline' | 'ignore';

export function isImeComposing(e: EnterKey): boolean {
  return !!(e.isComposing || e.nativeEvent?.isComposing || e.keyCode === 229 || e.nativeEvent?.keyCode === 229);
}

export function baleComposerEnterAction(
  e: EnterKey,
  opts: { coarsePointer: boolean; canSend: boolean },
): ComposerEnterAction {
  if (e.key !== 'Enter') return 'ignore';
  if (isImeComposing(e)) return 'ignore';
  if (e.shiftKey) return 'newline';
  // Ctrl/Cmd+Enter still sends, including on a tablet with a keyboard.
  if (opts.coarsePointer && !e.ctrlKey && !e.metaKey) return 'newline';
  if (!opts.canSend) return 'ignore';
  return 'send';
}

/** Apply the action to a keyboard event: prevent the newline when sending or when Enter on empty/busy should do nothing. */
export function handleBaleComposerEnter(
  e: EnterKey & { preventDefault: () => void },
  opts: { coarsePointer: boolean; canSend: boolean },
  send: () => void,
): ComposerEnterAction {
  const action = baleComposerEnterAction(e, opts);
  if (e.key === 'Enter' && !isImeComposing(e) && action !== 'newline') {
    e.preventDefault();
    if (action === 'send') send();
  }
  return action;
}
