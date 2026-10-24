// Customer search by id: «1234», «#1234», «#۱۲۳۴» and Arabic digits all resolve to customer 1234.
// A leading «#» means "this id only"; a bare number also keeps the existing name/phone matching
// and only adds the exact id (ranked first).

const FA = "۰۱۲۳۴۵۶۷۸۹";
const AR = "٠١٢٣٤٥٦٧٨٩";

export function toLatinDigits(value: unknown): string {
  return String(value ?? "").replace(/[۰-۹٠-٩]/g, (d) => String(FA.includes(d) ? FA.indexOf(d) : AR.indexOf(d)));
}

export type CustomerIdQuery = { id: number; explicit: boolean };

export function parseCustomerIdQuery(raw: unknown): CustomerIdQuery | null {
  const m = /^([#＃])?\s*(\d{1,9})$/.exec(toLatinDigits(raw).trim());
  if (!m) return null;
  const id = Number(m[2]);
  return id > 0 ? { id, explicit: Boolean(m[1]) } : null;
}

/** The search text with digits made Latin and a leading «#» removed, for the existing LIKE clauses. */
export function normalizeCustomerSearchText(raw: unknown): string {
  return toLatinDigits(raw).trim().replace(/^[#＃]\s*/, "");
}

export type CustomerSearchSql = {
  /** Text to use for the existing LIKE parameters (digits normalised, «#» dropped). */
  text: string;
  idQuery: CustomerIdQuery | null;
  /**
   * Wraps an existing text-match condition: `(existing OR <idColumn>=?)`, or only the id
   * condition for an explicit «#id». Params must be appended in the order returned.
   */
  where: (existingCondition: string, existingParams: Array<string | number>, idColumn: string, explicitAlso?: { sql: string; params: Array<string | number> }) => { sql: string; params: Array<string | number> };
  /** ORDER BY prefix that ranks the exact id first ("" when the query is not an id). */
  orderPrefix: (idColumn: string) => { sql: string; params: Array<string | number> };
};

export function customerSearchSql(raw: unknown): CustomerSearchSql {
  const idQuery = parseCustomerIdQuery(raw);
  const text = normalizeCustomerSearchText(raw);
  return {
    text,
    idQuery,
    where: (existingCondition, existingParams, idColumn, explicitAlso) => {
      if (!idQuery) return { sql: existingCondition, params: existingParams };
      if (idQuery.explicit) {
        // «#id» on a record list (orders, purchases, cases) may also mean the record number shown as «#…».
        return explicitAlso
          ? { sql: `(${idColumn}=? OR ${explicitAlso.sql})`, params: [idQuery.id, ...explicitAlso.params] }
          : { sql: `(${idColumn}=?)`, params: [idQuery.id] };
      }
      return { sql: `(${existingCondition} OR ${idColumn}=?)`, params: [...existingParams, idQuery.id] };
    },
    orderPrefix: (idColumn) => idQuery
      ? { sql: `CASE WHEN ${idColumn}=? THEN 0 ELSE 1 END, `, params: [idQuery.id] }
      : { sql: "", params: [] },
  };
}

/**
 * «وضعیت تراکنش‌ها» commission side (team_commission_purchases t, customer c, payment order o).
 * A number matches purchase #, order #, customer id or part of the mobile (unchanged), and the exact
 * customer id ranks first; text matches the customer name as before.
 */
export function commissionStatusSearchSql(raw: unknown): {
  where: { sql: string; params: Array<string | number> } | null;
  order: { sql: string; params: Array<string | number> };
} {
  const search = String(raw ?? "").trim();
  if (!search) return { where: null, order: { sql: "", params: [] } };
  const digits = normalizeCustomerSearchText(search);
  if (/^\d{1,9}$/.test(digits)) {
    const n = Number(digits);
    return {
      where: { sql: "(t.purchase_id=? OR o.id=? OR c.id=? OR c.phone LIKE ?)", params: [n, n, n, `%${digits}%`] },
      order: { sql: "CASE WHEN c.id=? THEN 0 ELSE 1 END,", params: [n] },
    };
  }
  return { where: { sql: "crm_persian_search_key(c.name) LIKE crm_persian_search_key(?)", params: [`%${search}%`] }, order: { sql: "", params: [] } };
}
