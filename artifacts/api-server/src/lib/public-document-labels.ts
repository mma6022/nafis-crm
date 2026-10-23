const identityLabels: Record<string, string> = {
  national_card_front: "روی کارت ملی",
  national_card_back: "پشت کارت ملی",
  birth_certificate_first_page: "صفحه اول شناسنامه",
  birth_certificate_second_page: "صفحه دوم شناسنامه",
  birth_certificate_last_page: "صفحه آخر شناسنامه",
  birth_cert_p1: "صفحه اول شناسنامه",
  birth_cert_p2: "صفحه دوم شناسنامه",
  birth_cert_last: "صفحه آخر شناسنامه",
};

/** Display names only: the stored requirement key is never changed. */
export function publicDocumentLabel(key: string, configuredLabel?: string | null): string {
  const label = configuredLabel?.trim();
  if (label && /[\u0600-\u06ff]/.test(label)) return label;
  return identityLabels[key] || (/[\u0600-\u06ff]/.test(key) ? key : "نام فارسی مدرک ثبت نشده است");
}
