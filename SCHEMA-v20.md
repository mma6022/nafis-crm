# Today-layout v2.0 schema changes (for the PostgreSQL cutover)

Additive only. No existing columns, contracts, loan_plans rows, team_sales_config, or notification_settings are changed.

```sql
CREATE TABLE IF NOT EXISTS customer_dossier (
  customer_id INTEGER PRIMARY KEY,
  city TEXT,
  amount_toman BIGINT,
  credit_rank TEXT,
  g_job_status TEXT,
  g_credit_rank TEXT,
  g_conditions TEXT,
  customer_note TEXT,
  answers_json TEXT,
  updated_at TEXT,
  actor_user_id INTEGER,
  actor_name TEXT
);
```

All seven §5.2 fields (`city`, `amount_toman`, `credit_rank`, `g_job_status`, `g_credit_rank`, `g_conditions`, `customer_note`) are nullable. `answers_json` holds the rest of the wizard (site keys, documents, expert `note`, simple-form extras). Upsert key is `customer_id`.

API: `GET /api/customers/:id/file-card` adds `dossier`, `dossierComplete`, `dossierPartial`, `sitePrefill` (existing fields unchanged). `POST /api/customers/:id/file-card` with `{ formVersion: 20, dossier }` upserts this table and does not run the old first-call required-field validator. A POST without `formVersion: 20` is unchanged.
