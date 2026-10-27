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
/**
 * customers.source (coarse channel) from the create path — documented mapping:
 *   staff_form → staff · site_lead → form · site_callback → site · portal → site · instagram / instagram_auto → instagram ·
 *   assistant → assistant · api → api.
 * A customer whose lead_source is «instagram» (the registrar's choice, or the per-seller default SETTING
 * lead_intake_settings.default_source_by_seller — seeded {22: instagram}, replacing the PM 22:27 user-31 constant) gets «instagram».
 */
export const CUSTOMER_SOURCE_BY_REGISTRATION = {
  staff_form: "staff", site_lead: "form", site_callback: "site", portal: "site", instagram: "instagram", instagram_auto: "instagram",
  assistant: "assistant", api: "api",
} as const;
export const CUSTOMER_SOURCE_LABELS: Record<string, string> = {
  staff: "کارمندان", form: "فرم سایت", site: "سایت", instagram: "اینستاگرام", assistant: "دستیارها", api: "API",
};
export function customerSourceFor(registration: keyof typeof CUSTOMER_SOURCE_BY_REGISTRATION, leadSource: string | null | undefined): string {
  if (leadSource === "instagram") return "instagram";
  return CUSTOMER_SOURCE_BY_REGISTRATION[registration];
}
export type RegistrationSource = keyof typeof REGISTRATION_SOURCES;
export const isRegistrationSource = (v: unknown): v is RegistrationSource => typeof v === "string" && Object.prototype.hasOwnProperty.call(REGISTRATION_SOURCES, v);

