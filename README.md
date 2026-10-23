# nafisvam-web

Static Astro site for **nafisvam.com** (Persian, RTL, mobile-first). Astro 7 + React 19 islands + Tailwind v4 + MDX.

## Requirements
Node 22+, pnpm. (On the shared box: `export PATH=~/.local/node22/bin:$PATH`.)

## Commands
| Command | What it does |
|---|---|
| `pnpm dev` | Dev server on :4321 |
| `pnpm test` | Unit tests (`node --test`, plan finder + lead payload) |
| `pnpm lint` | ESLint |
| `pnpm build` | **Production**: `astro check` → `astro build` → `check-markers --strict` (fails on any marker) → JSON-LD check |
| `pnpm build:preview` | Dev/preview: same, but markers are only reported (fails only if a source marker was dropped) |
| `pnpm build:fast` | Build only |
| `pnpm preview` | Serve `dist/` |
| `pnpm check:markers [--strict]` | Placeholder-marker report (see below) |
| `pnpm check:jsonld` | Validates every JSON-LD block; FAQPage shape; post FAQ section ⇔ FAQPage |

## Content (fa / en)
- **Visitor-facing copy is Persian** and lives in Markdown/MDX:
  - `src/content/pages/*.mdx`: home (`slug: /`) + 6 keyword landing pages (frontmatter: title, description, primaryKeyword, h1, cta, faq…). Routes come from `slug`.
  - `src/content/blog/*.mdx`: magazine posts (frontmatter `faq` → visible FAQ section + FAQPage JSON-LD, markers stripped from the JSON-LD); categories/tags in `src/data/blog-taxonomy.ts`.
  - `src/data/faq.ts`: shared FAQ.
- **Code, comments, and commit messages are English.**
- Plan facts (amounts, installments, terms, review time) are **never typed by hand**. They come from `src/data/loan-plans.snapshot.json` (build-time) and are refreshed client-side from `https://nafisvam.com/loan-plans.json` (`src/scripts/live-facts.ts`). Frontmatter/MDX text may use `{planCount}`, `{cashCount}`, `{goodsCount}`, `{bankCount}`, `{fastCount}`, `{minTerm}`, `{maxTerm}`, `{amountRange}`, `{termRange}` (filled by `fillFacts`), and components like `<PlanCards>` / `<Calculator>`.
- Site-wide constants (phone, URLs, logo) are in `src/lib/site.ts`. Design tokens are defined **once** in `src/styles/global.css` (`@theme`).
- All canonical/OG/sitemap URLs are absolute on `https://nafisvam.com`.

## Lead endpoint (`PUBLIC_LEAD_ENDPOINT`)
`/request` (noindex) is a 3-step wizard (need → amount → contact). It POSTs JSON to `PUBLIC_LEAD_ENDPOINT`:
`name, phone, need, amountBand, planId?, term?, contactTime, src, consent, website (honeypot, ""), startedAt, utm_*`.
- Success is shown **only on 2xx**; anything else shows an error with the phone number and keeps the inputs.
- The CRM rejects unknown keys (400) and submits faster than 3 s (422). Payload builder + tests: `src/lib/lead.ts`, `tests/lead.test.ts`.
- The variable is inlined at build time: set it in `.env` or the build env (see `.env.example`). The CRM must allow CORS from `https://nafisvam.com`.

## Placeholder markers
`[تأیید محمد…]` (needs Mohammad's approval) and `[جای‌خالی…]` (content missing) are intentionally **visible** in dev/preview builds (styled `.ph`).
- `pnpm build:preview` / `pnpm check:markers` list markers per page and fail only if a marker in source is missing from the output (silently dropped).
- `pnpm build` (production) runs `check-markers --strict` and **fails while any marker remains** (designer handoff rule).

## Not in this repo
Deployment (nginx, `/opt/nafisvam-site`) and the `loan-plans.json` exporter cron are on the server.
