import { crmDb, queryRow } from "./crm-db";

// Display preferences, not deletion or call blocking. Keep the actual numbers
// in the private database rather than embedding customer data in source code.
crmDb.exec(`CREATE TABLE IF NOT EXISTS voip_call_display_exclusions (
  phone TEXT PRIMARY KEY NOT NULL
    CHECK(length(phone) IN (10,11) AND phone LIKE '0%' AND phone NOT GLOB '*[^0-9]*')
)`);

export function normalizeDisplayPhone(value: string): string | null {
  let phone = value.replace(/[۰-۹]/g, x => String("۰۱۲۳۴۵۶۷۸۹".indexOf(x)))
    .replace(/[٠-٩]/g, x => String("٠١٢٣٤٥٦٧٨٩".indexOf(x))).replace(/\D/g, "");
  if (phone.startsWith("0098")) phone = "0" + phone.slice(4);
  else if (phone.startsWith("98")) phone = "0" + phone.slice(2);
  else if (phone.length === 10 && phone.startsWith("9")) phone = "0" + phone;
  return /^0\d{9,10}$/.test(phone) ? phone : null;
}

export function isExcludedCallPhone(value: string): boolean {
  const phone = normalizeDisplayPhone(value);
  return phone !== null && !!queryRow("SELECT phone FROM voip_call_display_exclusions WHERE phone=?", [phone]);
}