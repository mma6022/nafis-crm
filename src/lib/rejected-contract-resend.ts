type QueryRow = (sql: string, args?: any[]) => any;

/** A legacy retry reused the rejected upload instead of making a fresh file. */
export function rejectedDeliveryReusesFile(row: any, queryRow: QueryRow): boolean {
  if (!row || row.status !== "sent" || row.deleted_at || row.superseded_at ||
      !row.provider_contract_id || !row.provider_file_id ||
      String(row.provider_status ?? "").toLowerCase() !== "readyforsign") return false;
  return !!queryRow(`SELECT 1 FROM contract_generation_rejected_deliveries
    WHERE generation_id=? AND provider_file_id=? AND provider_contract_id<>?
      AND lower(provider_status) IN ('reject','rejected','declined','ردشد','ردشده')
    LIMIT 1`, [row.id, row.provider_file_id, row.provider_contract_id]);
}
