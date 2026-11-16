import type { DatabaseSync } from "node:sqlite";

export function goodsInvoiceMonth(issuedAt: Date): string {
  const parts = new Intl.DateTimeFormat("en-US-u-ca-persian-nu-latn", {
    timeZone: "Asia/Tehran", year: "numeric", month: "2-digit",
  }).formatToParts(issuedAt);
  const year = parts.find(part => part.type === "year")!.value.padStart(4, "0");
  const month = parts.find(part => part.type === "month")!.value.padStart(2, "0");
  return `${year}${month}`;
}

// Caller must reserve this number and insert its document in one transaction.
// Never recycle numbers belonging to failed, replaced, or signed documents.
export function reserveGoodsInvoiceNumber(db: DatabaseSync, issuedAt: Date): string {
  const month = goodsInvoiceMonth(issuedAt);
  const sequence = db.prepare(`INSERT INTO goods_invoice_sequences(month,last_number) VALUES(?,1)
    ON CONFLICT(month) DO UPDATE SET last_number=last_number+1 WHERE last_number<999
    RETURNING last_number`).get(month) as { last_number: number } | undefined;
  if (!sequence) throw new Error("invoice_monthly_sequence_exhausted");
  return `${month}${String(sequence.last_number).padStart(3, "0")}`;
}