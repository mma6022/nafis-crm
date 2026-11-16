/** Basic portal admission is independent of postal/Sana/credit loan eligibility. */
export function customerPortalIdentityReady(customer: any): boolean {
  if (!customer || customer.shahkar_ok !== 1 || customer.person_info_ok !== 1) return false;
  const complete = [customer.name, customer.first_name || customer.official_first_name,
    customer.last_name || customer.official_last_name, customer.father_name,
    customer.national_code, customer.birth_date_jalali].every(value => typeof value === "string" && value.trim());
  const checked = Date.parse(String(customer.verification_checked_at ?? ""));
  const changed = customer.identity_changed_at == null ? -Infinity : Date.parse(String(customer.identity_changed_at));
  return complete && Number.isFinite(checked) && checked >= changed;
}
