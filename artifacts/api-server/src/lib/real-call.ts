/** Timeline rows in call_logs that are NOT a call with the customer (P1 hand-off note, manager first-call accuracy review).
 *  Dependency-free so every call counter (site leads, sales box, assistants, manager reports) shares one definition. */
export function realCallSql(subjectColumn: string): string {
  return `(COALESCE(${subjectColumn},'') NOT LIKE 'ارتقا به اولویت ۱ توسط%' AND COALESCE(${subjectColumn},'') NOT IN ('اطلاعات تماس اول درست بود','اطلاعات تماس اول درست نبود') AND COALESCE(${subjectColumn},'') NOT LIKE 'کارهای امروز ·%')`;
}
