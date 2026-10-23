export function creditProviderFailure(status: string | null, title?: string | null): string | null {
  if (status === "RequestExpired" || /^RequestExpired\b/i.test(title?.trim() ?? "")) {
    return "اعتبار این درخواست به پایان رسیده است. استعلام جدیدی آغاز کنید؛ نتیجهٔ موفق قبلی محفوظ است.";
  }
  if (status === "NotMatchingRealPersonNationalCodeAndMobileNumber") {
    return "کد ملی و شماره موبایل با یکدیگر تطابق ندارند. شمارهٔ موبایل متعلق به مشتری را بررسی و اصلاح کنید، سپس استعلام جدید بگیرید.";
  }
  if (status && ["IdentityCheckFailed", "ReportGenerationFailed", "ReportGeneratedButDataLost"].includes(status)) {
    return title || "استعلام اعتبارسنجی ناموفق بود.";
  }
  return null;
}