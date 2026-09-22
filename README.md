# Nafis CRM

A Persian, RTL customer relationship management workspace with customer records, follow-ups, credit assessment history, loan applications, notifications, access control, and AI-assisted consultation.

## Workspace

- `artifacts/crm-dashboard` — React/Vite CRM dashboard
- `artifacts/api-server` — Express API server
- `lib/api-spec` — OpenAPI specification
- `lib/api-client-react` — generated React API client
- `lib/api-zod` — generated validation schemas

## Local development

```bash
pnpm install
pnpm --filter @workspace/api-server run dev
pnpm --filter @workspace/crm-dashboard run dev
```

Runtime databases, customer documents, reports, backups, deployment-only files, and environment secrets are intentionally excluded from this public repository.
