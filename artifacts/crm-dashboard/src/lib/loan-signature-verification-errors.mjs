function readFailure(error) {
  const failure = error && typeof error === 'object' ? error : {};
  const payload = failure.data ?? failure.response?.data;
  const rawCode = payload?.error ?? payload?.code;
  const status = Number(failure.response?.status ?? failure.status);
  return {
    code: typeof rawCode === 'string' ? rawCode.toLowerCase() : '',
    status: Number.isFinite(status) && status > 0 ? status : null,
    hasHttpResponse: Boolean(failure.response || (status > 0 && payload)),
  };
}

export function classifySignatureVerificationError(error) {
  const { code, status, hasHttpResponse } = readFailure(error);
  if (['action_forbidden', 'unauthorized', 'forbidden', 'access_denied'].includes(code)
    || status === 401 || status === 403) {
    return {
      kind: 'access_error',
      message: 'مجوز لازم برای استعلام وضعیت امضا در دسترس نیست.',
    };
  }
  if (['generated_document_not_found', 'document_not_found', 'not_found'].includes(code) || status === 404) {
    return {
      kind: 'missing_document',
      message: 'سند یا شناسهٔ آن پیدا نشد. فهرست را تازه کنید و دوباره تلاش کنید.',
    };
  }
  if (code === 'provider_status_failed' || code.startsWith('provider_status_failed:')) {
    return {
      kind: 'provider_error',
      message: 'دریافت وضعیت امضا از امضامی انجام نشد. کمی بعد دوباره تلاش کنید.',
    };
  }
  if (code === 'signature_processing_failed') {
    return {
      kind: 'processing_error',
      message: 'پاسخ امضامی دریافت شد، اما ثبت نتیجه در CRM انجام نشد. این خطا از پردازش داخلی سرور است.',
    };
  }
  if (!hasHttpResponse) {
    return {
      kind: 'network_error',
      message: 'ارتباط با سرور برقرار نشد و وضعیت امضا دریافت نشد. اتصال را بررسی کنید و دوباره تلاش کنید.',
    };
  }
  return {
    kind: 'unexpected_error',
    message: 'استعلام وضعیت امضا انجام نشد. دوباره تلاش کنید.',
  };
}

const normalizeProviderStatus = (value) => String(value ?? '').toLowerCase().replace(/[\s_\-\u200c]+/g, '');
const negativeProviderStatuses = [
  'unsigned', 'notsigned', 'notcompleted', 'notcomplete', 'uncompleted', 'uncomplete', 'incomplete',
  'unaccepted', 'notaccepted', 'notaccept', 'notfinished', 'unfinished', 'notdone', 'notyetsigned',
  'notsignedyet', 'reject', 'rejected', 'declined', 'cancelled', 'canceled', 'expired', 'voided', 'failed', 'failure',
  'ردشده', 'لغوشده', 'منقضی', 'امضانشده', 'تکمیل‌نشده',
].map(normalizeProviderStatus);
const pendingProviderStatuses = ['pending', 'waiting', 'readyforsign', 'readytobesigned', 'sent', 'created', 'درانتظار']
  .map(normalizeProviderStatus);
const signedProviderStatuses = new Set([
  'accept', 'accepted', 'signed', 'completed', 'complete', 'finished', 'done',
  'امضاشده', 'تکمیلشده', 'پذیرفتهشده',
].map(normalizeProviderStatus));

export function classifyProviderStatus(status) {
  const normalized = normalizeProviderStatus(status);
  if (!normalized) return 'unknown';
  if (negativeProviderStatuses.some((value) => normalized.includes(value))) return 'negative';
  if (pendingProviderStatuses.some((value) => normalized.includes(value))) return 'pending';
  if (signedProviderStatuses.has(normalized)) return 'signed';
  return 'unknown';
}

export function providerReportsSigned(status) {
  return classifyProviderStatus(status) === 'signed';
}

export function providerReportsRejected(status) {
  return ['reject', 'rejected', 'declined', 'ردشد', 'ردشده'].includes(normalizeProviderStatus(status));
}