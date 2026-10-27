/** crm-default-owner: pure constants (no DB import) shared by the rule, the admin API and the db-injected assistants runner. */
export const DEFAULT_OWNER_EXCLUDED_USER_IDS: readonly number[] = [29];

/** Intake channels (customers.registration_source). assistant / api have no create path today; listed so «همه» covers them. */
export const REGISTRATION_SOURCES = {
  staff_form: "فرم ثبت مشتری (کارمندان)",
  site_lead: "فرم سایت",
  site_callback: "درخواست تماس سایت",
  instagram: "اینستاگرام (تبدیل دستی)",
  instagram_auto: "اینستاگرام (خودکار)",
  portal: "پرتال مشتری",
  assistant: "دستیارها",
  api: "API",
} as const;
export type RegistrationSource = keyof typeof REGISTRATION_SOURCES;
export const isRegistrationSource = (v: unknown): v is RegistrationSource => typeof v === "string" && Object.prototype.hasOwnProperty.call(REGISTRATION_SOURCES, v);

