export type Channel = 'call' | 'whatsapp' | 'telegram' | 'bale';
export type PickerMode = Channel;

/**
 * Attributes for any element that opens the expert picker (data: ./experts.ts). role=button (it opens a dialog;
 * Enter/Space work via scripts/chrome.ts). Without JS (or before the picker loads) the href still goes to the /contact
 * «کارشناسان فروش» block, which lists the same experts with direct links.
 */
export const pickerTrigger = (mode: PickerMode = 'call') => ({
  href: '/contact/#experts',
  role: 'button' as const,
  'data-experts': mode,
  'aria-haspopup': 'dialog' as const,
});
