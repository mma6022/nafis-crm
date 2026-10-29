// Shared Persian text for contract-send failures that the expert must act on.
// Only maps API error codes to UI text; does not change the send flow or the Emzami certificate check.
export const CERTIFICATE_INACTIVE_MESSAGE = 'مشتری هنوز گواهی امضای فعال در امضامی ندارد. از مشتری بخواهید در اپ امضامی ثبت‌نام و احراز هویت کند، سپس دوباره ارسال کنید. کد ملی پرونده را هم بررسی کنید.';

export function readContractSendErrorCode(error) {
  const failure = error && typeof error === 'object' ? error : {};
  const payload = failure.data ?? failure.response?.data ?? failure.error;
  const code = payload?.error;
  return typeof code === 'string' ? code : '';
}

export function isCertificateInactiveError(error) {
  return readContractSendErrorCode(error) === 'certificate_inactive';
}

/** Returns the expert-facing message for a known contract-send code, or null. */
export function contractSendErrorMessage(code) {
  if (code === 'certificate_inactive') return CERTIFICATE_INACTIVE_MESSAGE;
  return null;
}
