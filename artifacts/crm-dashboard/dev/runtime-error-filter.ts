type RuntimeError = { message: string; stack?: string };

/** Filter only known development noise, never all errors mentioning an extension. */
export function shouldShowRuntimeError(error: RuntimeError): boolean {
  if ([
    'ResizeObserver loop completed with undelivered notifications.',
    'ResizeObserver loop limit exceeded',
  ].includes(error.message)) return false;

  // MetaMask injects this rejection even though the CRM does not use its provider.
  // Require both the exact message and the originating stack frame. A CRM error
  // mentioning MetaMask, or with an extension farther down its stack, stays visible.
  const firstFrame = error.stack?.split(/\r?\n/).find(line => /^\s*at\s/.test(line));
  const injectedMetaMaskFrame = /^\s*at\s+(?:[^(]*\()?chrome-extension:\/\/nkbihfbeogaeaoehlefnkodbefgpgknn\/scripts\/inpage\.js:\d+:\d+\)?\s*$/;
  return !(error.message === 'Failed to connect to MetaMask' &&
    firstFrame !== undefined && injectedMetaMaskFrame.test(firstFrame));
}
