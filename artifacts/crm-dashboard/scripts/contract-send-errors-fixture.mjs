import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CERTIFICATE_INACTIVE_MESSAGE, contractSendErrorMessage, isCertificateInactiveError, readContractSendErrorCode } from '../src/lib/contract-send-errors.mjs';

const EXPECTED = 'مشتری هنوز گواهی امضای فعال در امضامی ندارد. از مشتری بخواهید در اپ امضامی ثبت‌نام و احراز هویت کند، سپس دوباره ارسال کنید. کد ملی پرونده را هم بررسی کنید.';
assert.equal(CERTIFICATE_INACTIVE_MESSAGE, EXPECTED);
assert.equal(contractSendErrorMessage('certificate_inactive'), EXPECTED);
assert.equal(contractSendErrorMessage('provider_certificate_check_failed'), null);
assert.equal(contractSendErrorMessage(undefined), null);
// ApiError shape (data), axios-like (response.data) and react-query error wrapper
const api422 = { status: 422, data: { error: 'certificate_inactive' } };
assert.equal(readContractSendErrorCode(api422), 'certificate_inactive');
assert.equal(isCertificateInactiveError(api422), true);
assert.equal(isCertificateInactiveError({ response: { data: { error: 'certificate_inactive' } } }), true);
assert.equal(isCertificateInactiveError({ error: { error: 'certificate_inactive' } }), true);
assert.equal(isCertificateInactiveError({ data: { error: 'collaborator_invalid' } }), false);
assert.equal(isCertificateInactiveError(null), false);
assert.equal(isCertificateInactiveError(new Error('certificate_inactive')), false);
// every expert-facing send surface uses the shared text, and the raw code never becomes the message
for (const f of ['src/pages/Contracts.tsx', 'src/pages/LoanApplicationDetail.tsx', 'src/components/loan-applications/CreateWizard.tsx', 'src/components/loan-applications/RejectedContractResend.tsx']) {
  const src = readFileSync(new URL('../' + f, import.meta.url), 'utf8');
  assert.match(src, /CERTIFICATE_INACTIVE_MESSAGE/, f);
  assert.doesNotMatch(src, /گواهی امضای دیجیتال فعال ندارد|این مشتری گواهی امضای فعال ندارد/, f);
}
console.log('contract-send-errors fixture: ok');
