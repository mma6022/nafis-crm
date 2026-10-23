import type { DatabaseSync } from "node:sqlite";

type SalespersonUser = {
  id: number;
  role: string;
  username: string;
  full_name: string | null;
  mobile: string | null;
  salesperson_id: number | null;
};

const migrationVersion = "salesperson-user-identity-v1";

/**
 * Keep the legacy salesperson record as the stable attribution/commission key.
 * Existing linked identities are reused; customer ownership is never rewritten.
 */
export function ensureSalespersonIdentity(
  db: DatabaseSync,
  userId: number,
): number | null {
  const user = db
    .prepare(
      `SELECT id, role, username, full_name, mobile, salesperson_id
       FROM users WHERE id = ?`,
    )
    .get(userId) as SalespersonUser | undefined;
  if (!user) throw new Error("user_not_found");
  if (user.role !== "salesperson") {
    return user.salesperson_id == null ? null : Number(user.salesperson_id);
  }

  const displayName = user.full_name?.trim() || user.username;
  if (user.salesperson_id != null) {
    const duplicate = db
      .prepare(
        `SELECT id FROM users
         WHERE role = 'salesperson' AND salesperson_id = ? AND id <> ?
         LIMIT 1`,
      )
      .get(user.salesperson_id, user.id);
    if (duplicate) throw new Error("ambiguous_salesperson_identity");
    const identity = db
      .prepare("SELECT id FROM salespersons WHERE id = ?")
      .get(user.salesperson_id);
    if (!identity) throw new Error("salesperson_identity_not_found");
    db.prepare(
      `UPDATE salespersons
       SET name = COALESCE(?, name), mobile = COALESCE(?, mobile)
       WHERE id = ?`,
    ).run(
      user.full_name?.trim() || null,
      user.mobile?.trim() || null,
      user.salesperson_id,
    );
    return Number(user.salesperson_id);
  }

  const matchingByMobile =
    user.mobile?.trim()
      ? (db
          .prepare(
            `SELECT s.id FROM salespersons s
             WHERE TRIM(s.mobile) = ?
             ORDER BY s.id`,
          )
          .all(user.mobile.trim()) as Array<{ id: number }>)
      : [];
  const matchingByName = db
    .prepare(
      `SELECT s.id FROM salespersons s
       WHERE LOWER(TRIM(s.name)) = LOWER(TRIM(?))
       ORDER BY s.id`,
    )
    .all(displayName) as Array<{
    id: number;
  }>;
  // A single mobile match does not overrule several matching historical names.
  const candidates = [...new Set([...matchingByMobile, ...matchingByName].map((row) => Number(row.id)))];
  if (candidates.length > 1) throw new Error("ambiguous_salesperson_identity");
  if (candidates.length === 1) {
    const candidateId = candidates[0];
    const candidate = db.prepare("SELECT mobile FROM salespersons WHERE id = ?")
      .get(candidateId) as { mobile: string | null };
    if (user.mobile?.trim() && candidate.mobile?.trim() &&
        user.mobile.trim() !== candidate.mobile.trim()) {
      throw new Error("ambiguous_salesperson_identity");
    }
    const linkedUser = db
      .prepare("SELECT id FROM users WHERE salesperson_id = ? AND id <> ? LIMIT 1")
      .get(candidateId, user.id);
    if (linkedUser) throw new Error("ambiguous_salesperson_identity");
    db.prepare(
      `UPDATE salespersons
       SET name = COALESCE(?, name), mobile = COALESCE(?, mobile)
       WHERE id = ?`,
    ).run(
      user.full_name?.trim() || null,
      user.mobile?.trim() || null,
      candidateId,
    );
    db.prepare("UPDATE users SET salesperson_id = ? WHERE id = ?").run(
      candidateId,
      user.id,
    );
    return candidateId;
  }

  const salespersonId = Number(
    db
      .prepare(
        "INSERT INTO salespersons (name, mobile, created_at) VALUES (?, ?, ?)",
      )
      .run(
        displayName,
        user.mobile?.trim() || null,
        new Date().toISOString(),
      ).lastInsertRowid,
  );
  db.prepare("UPDATE users SET salesperson_id = ? WHERE id = ?").run(
    salespersonId,
    user.id,
  );
  return salespersonId;
}

type IdentityRow = { id: number; name: string; mobile: string | null };

export function salespersonIdentityReport(db: DatabaseSync) {
  const users = db.prepare(
    "SELECT id, username, full_name, mobile, salesperson_id FROM users WHERE role = 'salesperson' ORDER BY id",
  ).all() as SalespersonUser[];
  const identities = db.prepare(
    "SELECT id, name, mobile FROM salespersons ORDER BY id",
  ).all() as IdentityRow[];
  const links = db.prepare(
    "SELECT id, username, salesperson_id FROM users WHERE salesperson_id IS NOT NULL",
  ).all() as Array<{ id: number; username: string; salesperson_id: number }>;
  const hasGoods = !!db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'goods_purchases'",
  ).get();
  const hasLedger = !!db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'goods_finance_ledger'",
  ).get();
  const hasWallet = !!db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'goods_salesperson_wallets'",
  ).get();
  const issues = users.flatMap((user) => {
    const displayName = (user.full_name?.trim() || user.username).toLowerCase();
    const mobile = user.mobile?.trim();
    const matches = identities.filter((s) =>
      (mobile && s.mobile?.trim() === mobile) ||
      s.name.trim().toLowerCase() === displayName,
    );
    const shared = user.salesperson_id != null &&
      links.some((link) => link.id !== user.id && link.salesperson_id === user.salesperson_id);
    const missing = user.salesperson_id != null &&
      !identities.some((s) => s.id === user.salesperson_id);
    const taken = user.salesperson_id == null && matches.length === 1 &&
      links.some((link) => link.id !== user.id && link.salesperson_id === matches[0].id);
    const conflictingMobile = user.salesperson_id == null && matches.length === 1 &&
      !!mobile && !!matches[0].mobile?.trim() && matches[0].mobile.trim() !== mobile;
    if (!shared && !missing &&
        !(user.salesperson_id == null && (matches.length > 1 || taken || conflictingMobile))) return [];
    return [{
      userId: user.id, username: user.username, fullName: user.full_name,
      mobile: user.mobile, currentSalespersonId: user.salesperson_id,
      reason: shared ? "shared" : missing ? "missing" : taken ? "claimed" :
        conflictingMobile ? "conflicting_mobile" : "multiple",
      candidateIds: [...new Set([...matches.map((s) => s.id), ...(user.salesperson_id == null ? [] : [user.salesperson_id])])],
    }];
  });
  return {
    issues,
    identities: identities.map((identity) => ({
      ...identity,
      linkedUsers: links.filter((link) => link.salesperson_id === identity.id)
        .map(({ id, username }) => ({ id, username })),
      customers: (db.prepare(
        "SELECT id, name FROM customers WHERE salesperson_id = ? ORDER BY id",
      ).all(identity.id) as Array<{ id: number; name: string }>),
      purchases: hasGoods ? db.prepare(
        "SELECT id, customer_id AS customerId, stage, commission_toman AS commissionToman FROM goods_purchases WHERE salesperson_id = ? ORDER BY id",
      ).all(identity.id) : [],
      financialEntries: hasLedger ? db.prepare(
        "SELECT id, purchase_id AS purchaseId, kind, amount_toman AS amountToman FROM goods_finance_ledger WHERE salesperson_id = ? ORDER BY id",
      ).all(identity.id) : [],
      walletBalanceToman: hasWallet
        ? (db.prepare("SELECT balance_toman FROM goods_salesperson_wallets WHERE salesperson_id = ?")
          .get(identity.id) as { balance_toman: string } | undefined)?.balance_toman ?? null
        : null,
    })),
  };
}

/** Only change the account link. Historical ownership and finance rows are immutable here. */
export function resolveSalespersonIdentity(
  db: DatabaseSync,
  userId: number,
  expectedSalespersonId: number | null,
  choice: number | "new",
): number {
  db.exec("BEGIN IMMEDIATE");
  try {
    const user = db.prepare(
      "SELECT id, username, full_name, mobile, role, salesperson_id FROM users WHERE id = ?",
    ).get(userId) as SalespersonUser | undefined;
    const issue = salespersonIdentityReport(db).issues.find((row) => row.userId === userId);
    if (!user || user.role !== "salesperson" || !issue ||
        user.salesperson_id !== expectedSalespersonId) {
      throw new Error("identity_conflict");
    }
    let target: number;
    if (choice === "new") {
      target = Number(db.prepare(
        "INSERT INTO salespersons (name, mobile, created_at) VALUES (?, ?, ?)",
      ).run(user.full_name?.trim() || user.username, user.mobile?.trim() || null,
        new Date().toISOString()).lastInsertRowid);
    } else {
      if (!Number.isSafeInteger(choice) || choice < 1 ||
          !db.prepare("SELECT 1 FROM salespersons WHERE id = ?").get(choice) ||
          db.prepare("SELECT 1 FROM users WHERE salesperson_id = ? AND id <> ?").get(choice, userId)) {
        throw new Error("identity_conflict");
      }
      target = choice;
    }
    db.prepare("UPDATE users SET salesperson_id = ? WHERE id = ?").run(target, userId);
    db.exec("COMMIT");
    return target;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/**
 * Add identities only for unmapped salesperson-role users. Existing IDs and all
 * customer assignments remain untouched. Ambiguous legacy users are skipped so
 * they cannot block service startup or cause identity/customer ownership merges.
 */
export function reconcileSalespersonUserIdentities(
  db: DatabaseSync,
  warn: (userId: number, reason: string) => void,
): void {
  if (
    db
      .prepare("SELECT 1 FROM schema_migrations WHERE version = ?")
      .get(migrationVersion)
  ) {
    return;
  }

  db.exec("BEGIN");
  try {
    const users = db
      .prepare("SELECT id FROM users WHERE role = 'salesperson' ORDER BY id")
      .all() as Array<{ id: number }>;
    let unresolved = false;
    for (const user of users) {
      const userId = Number(user.id);
      const savepoint = `salesperson_user_${userId}`;
      db.exec(`SAVEPOINT ${savepoint}`);
      try {
        ensureSalespersonIdentity(db, userId);
        db.exec(`RELEASE SAVEPOINT ${savepoint}`);
      } catch (error) {
        db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        db.exec(`RELEASE SAVEPOINT ${savepoint}`);
        if (
          error instanceof Error &&
          error.message === "ambiguous_salesperson_identity"
        ) {
          unresolved = true;
          warn(userId, error.message);
          continue;
        }
        throw error;
      }
    }

    const duplicateLink = db
      .prepare(
        `SELECT 1
         FROM users
         WHERE role = 'salesperson' AND salesperson_id IS NOT NULL
         GROUP BY salesperson_id
         HAVING COUNT(*) > 1
         LIMIT 1`,
      )
      .get();
    if (!duplicateLink) {
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_users_salesperson_identity_unique
        ON users(salesperson_id)
        WHERE role = 'salesperson' AND salesperson_id IS NOT NULL;
      `);
    } else {
      unresolved = true;
    }

    if (!unresolved) {
      db.prepare(
        "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
      ).run(migrationVersion, new Date().toISOString());
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}