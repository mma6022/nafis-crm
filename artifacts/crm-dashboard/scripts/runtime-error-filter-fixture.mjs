import assert from 'node:assert/strict';
import { shouldShowRuntimeError } from '../dev/runtime-error-filter.ts';

const message = 'Failed to connect to MetaMask';
const extension = 'chrome-extension://nkbihfbeogaeaoehlefnkodbefgpgknn/scripts/inpage.js:12:4822';
assert.equal(shouldShowRuntimeError({ message, stack: `Error: ${message}\n    at Object.connect (${extension})` }), false);
assert.equal(shouldShowRuntimeError({ message, stack: `Error: ${message}\n    at ${extension}` }), false);
assert.equal(shouldShowRuntimeError({ message, stack: `Error: ${message}\n    at connect (https://crm.test/src/main.tsx:12:4)` }), true);
assert.equal(shouldShowRuntimeError({ message, stack: `Error: ${message}\n    at connect (https://crm.test/src/main.tsx:12:4)\n    at Object.connect (${extension})` }), true);
assert.equal(shouldShowRuntimeError({ message }), true);
assert.equal(shouldShowRuntimeError({ message: 'Real CRM failure', stack: `Error\n    at Object.connect (${extension})` }), true);
assert.equal(shouldShowRuntimeError({ message: '(unknown runtime error)' }), true);
assert.equal(shouldShowRuntimeError({ message: 'ResizeObserver loop completed with undelivered notifications.' }), false);
assert.equal(shouldShowRuntimeError({ message: 'ResizeObserver loop limit exceeded' }), false);
console.log('PASS runtime overlay: only the exact extension-origin MetaMask rejection and known layout notifications are excluded; real CRM and unknown errors remain visible.');
