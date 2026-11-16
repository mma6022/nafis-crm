import type { DatabaseSync } from "node:sqlite";

// Each edge must agree with both the archive pointer and the immutable audit.
// UNION (not UNION ALL) also makes malformed cycles terminate safely.
export const customerMergeFamilySql = `
  WITH RECURSIVE family(customer_id,origin_customer_id) AS (
    SELECT id,id FROM customers WHERE merged_into_customer_id IS NULL
    UNION
    SELECT family.customer_id,source.id FROM family
    JOIN customers source ON source.merged_into_customer_id=family.origin_customer_id
    JOIN customer_merge_audit audit ON audit.source_customer_id=source.id
      AND audit.survivor_customer_id=family.origin_customer_id
  )`;

export function installCustomerChatHistory(db: DatabaseSync): void {
  db.exec(`
    CREATE VIEW IF NOT EXISTS customer_chat_owners AS
    ${customerMergeFamilySql} SELECT * FROM family;
    CREATE VIEW IF NOT EXISTS customer_chat_history AS
    SELECT m.id,f.customer_id,m.customer_id origin_customer_id,
      m.sender_type,m.sender_id,m.sender_name,m.text,m.kind,m.object_path,
      m.file_name,m.mime_type,m.file_size,m.client_id,m.content_hash,m.created_at
    FROM customer_chat_messages m JOIN customer_chat_owners f ON f.origin_customer_id=m.customer_id;
  `);
}

// A watermark from one original conversation must NEVER mark another one read.
// Customer identity is rebound for authorization, not for historical attribution.
export const chatReadMarkerSql = `COALESCE((
  SELECT MAX(r.last_message_id) FROM customer_chat_reads r
  WHERE r.customer_id=m.origin_customer_id AND r.reader_type=?
    AND (r.reader_id=? OR (r.reader_type='customer' AND r.reader_id IN (
      SELECT origin_customer_id FROM customer_chat_owners WHERE customer_id=m.customer_id)))
),0)`;

export function markCustomerChatRead(
  db: DatabaseSync, customerId: number, readerType: string, readerId: number, last: number,
): void {
  const origins = db.prepare(`SELECT origin_customer_id,MAX(id) last_id
    FROM customer_chat_history WHERE customer_id=? AND id<=? GROUP BY origin_customer_id`)
    .all(customerId, last) as Array<{ origin_customer_id: number; last_id: number }>;
  const update = db.prepare(`INSERT INTO customer_chat_reads
    (customer_id,reader_type,reader_id,last_message_id) VALUES(?,?,?,?)
    ON CONFLICT(customer_id,reader_type,reader_id)
    DO UPDATE SET last_message_id=MAX(last_message_id,excluded.last_message_id)`);
  for (const origin of origins) {
    update.run(origin.origin_customer_id, readerType, readerId, origin.last_id);
  }
}

export type ChatRetryMessage = {
  id: number; text: string; content_hash: string | null; sender_id: number;
  origin_customer_id: number; object_path: string | null;
};

export function findCustomerChatRetry<T extends ChatRetryMessage>(
  db: DatabaseSync, customerId: number, senderType: string, senderId: number,
  clientId: string, text: string, hash: string, textOnly = false,
): T | undefined {
  // Customer sender IDs remain the original IDs after a merge. Staff IDs never
  // alias: being a previous sender does not grant any current thread access.
  const candidates = db.prepare(`SELECT * FROM customer_chat_history
    WHERE customer_id=? AND sender_type=? AND client_id=?
    AND (sender_id=? OR (?='customer' AND sender_id=origin_customer_id))
    ORDER BY id`).all(customerId, senderType, clientId, senderId, senderType) as T[];
  const match = candidates.find(m => m.text === text && m.content_hash === hash);
  if (match) return match;
  // Pre-hash text-only legacy retries are safe only when unambiguous.
  if (candidates.length === 1 && candidates[0].text === text
    && candidates[0].content_hash == null && textOnly
    && !candidates[0].object_path) return candidates[0];
  if (candidates.length) throw new Error("chat_idempotency_conflict");
  return undefined;
}
