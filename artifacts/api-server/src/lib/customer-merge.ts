import type { DatabaseSync } from "node:sqlite";
import { normalizeCustomerMobile } from "./customer-integrity";

type CustomerIdentity = { phone: string; national_code: string | null };
export type CustomerIdentityComparison = {
  isDuplicate: boolean;
  nationalCodeMatches: boolean;
  conflictingNationalCodes: boolean;
};

export type ReparentedCustomerHistory = Record<string, number>;
export type CustomerMergeOutcome = {
  reparentedHistoryCounts: ReparentedCustomerHistory;
  preservedFinancialArtifacts: string[];
};

const customerHistoryTables = [
  "call_logs",
  "reminders",
  "consultation_forms",
  "loan_applications",
  "consultation_ai_conversations",
  "notification_deliveries",
  "contract_generations",
  "voip_browser_calls",
] as const;

const requiredHistoryTables = new Set([
  "call_logs",
  "reminders",
  "consultation_forms",
  "loan_applications",
]);

const retainedFinancialTables = [
  ["goods_purchases", "SELECT COUNT(*) AS count FROM goods_purchases WHERE customer_id=?"],
  ["loan_filing_fee_charges", "SELECT COUNT(*) AS count FROM loan_filing_fee_charges WHERE customer_id=?"],
  ["wallet_accounts", "SELECT COUNT(*) AS count FROM wallet_accounts WHERE customer_id=?"],
  ["wallet_accounts_v2", "SELECT COUNT(*) AS count FROM wallet_accounts_v2 WHERE customer_id=?"],
  ["wallet_ledger", "SELECT COUNT(*) AS count FROM wallet_ledger l JOIN wallet_accounts w ON w.id=l.account_id WHERE w.customer_id=?"],
  ["wallet_ledger_v2", "SELECT COUNT(*) AS count FROM wallet_ledger_v2 l JOIN wallet_accounts_v2 w ON w.id=l.wallet_id WHERE w.customer_id=?"],
  ["goods_plan_wallets", "SELECT COUNT(*) AS count FROM goods_plan_wallets WHERE customer_id=?"],
  ["goods_finance_ledger", "SELECT COUNT(*) AS count FROM goods_finance_ledger WHERE customer_id=?"],
  ["goods_credit_lots", "SELECT COUNT(*) AS count FROM goods_credit_lots l JOIN goods_plan_wallets w ON w.id=l.wallet_id WHERE w.customer_id=?"],
  ["company_wallet_ledger", "SELECT COUNT(*) AS count FROM company_wallet_ledger l JOIN loan_filing_fee_charges c ON c.id=l.fee_charge_id WHERE c.customer_id=?"],
] as const;

function tableExists(db: DatabaseSync, table: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

/**
 * Move only explicitly reviewed customer-keyed histories. Caller MUST run this
 * inside the same transaction as source archival, reassignment, and audit insert.
 * Any SQLite constraint error is intentionally allowed to escape and abort it.
 */
export function reparentCustomerHistories(
  db: DatabaseSync,
  sourceCustomerId: number,
  targetCustomerId: number,
  nationalCodeMatches: boolean,
): ReparentedCustomerHistory {
  const moved: ReparentedCustomerHistory = {};
  for (const table of customerHistoryTables) {
    if (!tableExists(db, table)) {
      if (requiredHistoryTables.has(table)) {
        throw new Error(`Required customer history table is missing: ${table}`);
      }
      continue;
    }
    const result = db.prepare(`UPDATE "${table}" SET customer_id=? WHERE customer_id=?`)
      .run(targetCustomerId, sourceCustomerId);
    if (Number(result.changes)) moved[table] = Number(result.changes);
  }

  // Verification evidence is identity-specific. Never mix it across a
  // phone-only merge; if national identities match, move only the events.
  if (nationalCodeMatches && tableExists(db, "customer_verification_events")) {
    const result = db.prepare(
      "UPDATE customer_verification_events SET customer_id=? WHERE customer_id=?",
    ).run(targetCustomerId, sourceCustomerId);
    if (Number(result.changes)) moved.customer_verification_events = Number(result.changes);
  }

  if (tableExists(db, "customer_identity_documents")) {
    // Preserve every file and version. When both records have a current document
    // of the same type, archive the source's current version before reparenting.
    db.prepare(`
      UPDATE customer_identity_documents AS source
      SET is_latest=0
      WHERE source.customer_id=? AND source.is_latest=1
        AND EXISTS (
          SELECT 1 FROM customer_identity_documents AS target
          WHERE target.customer_id=? AND target.document_type=source.document_type
            AND target.is_latest=1
        )
    `).run(sourceCustomerId, targetCustomerId);
    const result = db.prepare(
      "UPDATE customer_identity_documents SET customer_id=? WHERE customer_id=?",
    ).run(targetCustomerId, sourceCustomerId);
    if (Number(result.changes)) moved.customer_identity_documents = Number(result.changes);
  }
  return moved;
}

export function mergeCustomerRecords(
  db: DatabaseSync,
  sourceCustomerId: number,
  targetCustomerId: number,
  actorUserId: number,
  salespersonId: number,
  createdAt: string,
  compareIdentity: (source: CustomerIdentity, target: CustomerIdentity) => CustomerIdentityComparison,
): CustomerMergeOutcome {
  db.exec("BEGIN IMMEDIATE");
  try {
    const source = db.prepare(
      `SELECT c.phone,c.national_code,c.merged_into_customer_id,c.salesperson_id,
        s.name salesperson_name
       FROM customers c LEFT JOIN salespersons s ON s.id=c.salesperson_id WHERE c.id=?`,
    ).get(sourceCustomerId) as {
      phone: string; national_code: string | null; merged_into_customer_id: number | null;
      salesperson_id: number | null; salesperson_name: string | null;
    } | undefined;
    const target = db.prepare(
      `SELECT c.id,c.phone,c.national_code,c.merged_into_customer_id,c.salesperson_id,
        s.name salesperson_name
       FROM customers c LEFT JOIN salespersons s ON s.id=c.salesperson_id WHERE c.id=?`,
    ).get(targetCustomerId) as {
      id: number; phone: string; national_code: string | null; merged_into_customer_id: number | null;
      salesperson_id: number | null; salesperson_name: string | null;
    } | undefined;
    if (!source || !target) throw new Error("customer_not_found");
    if (source.merged_into_customer_id !== null || target.merged_into_customer_id !== null) {
      throw new Error("customer_already_merged");
    }
    const identityComparison = compareIdentity(source, target);
    if (identityComparison.conflictingNationalCodes) {
      throw new Error("conflicting_national_codes");
    }
    if (!identityComparison.isDuplicate) {
      throw new Error("customers_not_duplicates");
    }
    if (!db.prepare("SELECT id FROM salespersons WHERE id=?").get(salespersonId)) {
      throw new Error("salesperson_not_found");
    }

    const sourceOwnerAtMerge = {
      salespersonId: source.salesperson_id,
      salespersonName: source.salesperson_name,
    };
    const survivorOwnerAtMerge = {
      salespersonId: target.salesperson_id,
      salespersonName: target.salesperson_name,
    };
    db.prepare("UPDATE customers SET merged_into_customer_id=?,status='cancelled' WHERE id=?")
      .run(targetCustomerId, sourceCustomerId);
    const history = reparentCustomerHistories(
      db, sourceCustomerId, targetCustomerId, identityComparison.nationalCodeMatches,
    );
    const repeatRequestsExist = tableExists(db, "customer_repeat_requests");
    if (repeatRequestsExist) {
      const result = db.prepare(
        "UPDATE customer_repeat_requests SET customer_id=? WHERE customer_id=?",
      ).run(targetCustomerId, sourceCustomerId);
      if (Number(result.changes)) history.customer_repeat_requests = Number(result.changes);
    }
    if (tableExists(db, "customer_tags")) {
      const sourceTags = db.prepare(
        "SELECT tag,created_at FROM customer_tags WHERE customer_id=?",
      ).all(sourceCustomerId) as Array<{ tag: string; created_at: string }>;
      const addTag = db.prepare(
        "INSERT OR IGNORE INTO customer_tags(customer_id,tag,created_at) VALUES(?,?,?)",
      );
      for (const tag of sourceTags) {
        addTag.run(targetCustomerId, tag.tag, tag.created_at);
      }
      db.prepare("DELETE FROM customer_tags WHERE customer_id=?").run(sourceCustomerId);

      if (repeatRequestsExist) {
        const pending = Number((db.prepare(
          "SELECT COUNT(*) AS count FROM customer_repeat_requests WHERE customer_id=? AND status='pending'",
        ).get(targetCustomerId) as { count: number }).count ?? 0);
        if (pending > 0) {
          const tagCatalogExists = tableExists(db, "customer_tag_catalog");
          const managedTagExists = !tagCatalogExists || Boolean(db.prepare(
            "SELECT tag FROM customer_tag_catalog WHERE tag='repeat_request'",
          ).get());
          if (managedTagExists) {
            addTag.run(targetCustomerId, "repeat_request", createdAt);
          }
        } else {
          db.prepare(
            "DELETE FROM customer_tags WHERE customer_id=? AND tag='repeat_request'",
          ).run(targetCustomerId);
        }
      }
    }
    db.prepare("UPDATE customers SET salesperson_id=? WHERE id=?").run(salespersonId, targetCustomerId);

    // Only transfer proof of the survivor's CURRENT phone. Other source
    // sessions stay archived and are rejected by portal authentication.
    if (tableExists(db, "customer_portal_sessions")) {
      const sessions = db.prepare(
        "SELECT token_hash,mobile FROM customer_portal_sessions WHERE customer_id=?",
      ).all(sourceCustomerId) as Array<{ token_hash: string; mobile: string }>;
      const mobile = normalizeCustomerMobile(target.phone);
      for (const session of sessions) {
        if (mobile && normalizeCustomerMobile(session.mobile) === mobile
          && normalizeCustomerMobile(source.phone) === mobile) {
          db.prepare("UPDATE customer_portal_sessions SET customer_id=? WHERE token_hash=?")
            .run(targetCustomerId, session.token_hash);
        }
      }
    }
    // Presence is transient, not proof that a rebound identity is still online.
    // A fresh authenticated heartbeat will establish survivor presence.
    if (tableExists(db, "customer_chat_presence")) {
      db.prepare("UPDATE customer_chat_presence SET last_seen=? WHERE actor_type='customer' AND actor_id=?")
        .run("1970-01-01T00:00:00.000Z", sourceCustomerId);
    }

    const preserved: string[] = [];
    if (tableExists(db, "customer_chat_messages")) {
      const count = Number((db.prepare(
        "SELECT COUNT(*) AS count FROM customer_chat_messages WHERE customer_id=?",
      ).get(sourceCustomerId) as { count: number }).count);
      preserved.push(`customer_chat_messages: ${count} original rows retained; audited history is accessible through survivor ${targetCustomerId}`);
    }
    for (const [table, sql] of retainedFinancialTables) {
      if (!tableExists(db, table)) continue;
      const count = Number((db.prepare(sql).get(sourceCustomerId) as { count: number }).count ?? 0);
      preserved.push(`${table}: ${count} rows remain linked to archived source customer ${sourceCustomerId}`);
    }
    if (tableExists(db, "customer_credit_checks")) {
      const count = Number((db.prepare(
        "SELECT COUNT(*) AS count FROM customer_credit_checks WHERE customer_id=?",
      ).get(sourceCustomerId) as { count: number }).count ?? 0);
      preserved.push(`customer_credit_checks: ${count} historical rows remain linked to archived source customer ${sourceCustomerId} to avoid changing the survivor's current rank`);
    }
    db.prepare(`
      INSERT INTO customer_merge_audit
        (survivor_customer_id,source_customer_id,actor_user_id,assigned_salesperson_id,created_at,details_json)
      VALUES(?,?,?,?,?,?)
    `).run(targetCustomerId, sourceCustomerId, actorUserId, salespersonId, createdAt,
      JSON.stringify({
        reparentedHistoryCounts: history,
        preservedFinancialArtifacts: preserved,
        sourceOwnerAtMerge,
        survivorOwnerAtMerge,
      }));
    db.exec("COMMIT");
    return { reparentedHistoryCounts: history, preservedFinancialArtifacts: preserved };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}