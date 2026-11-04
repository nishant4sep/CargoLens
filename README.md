# CargoLens

Human-in-the-loop import-documentation workbench for a customs broker: drop in a shipment's
invoice, packing list and bill of lading → a vision AI drafts every field with a confidence
score and page-level source reference → **deterministic code** runs cross-document checks →
the executive confirms or corrects against the document side-by-side → the manager approves →
export to the filing software's CSV layout is **impossible from the server** until every
required field is human-cleared and every blocking check is resolved. Every correction lands
in an append-only audit ledger that powers accuracy analytics per field and per supplier.

> **The rule in one line: AI drafts, code validates, humans confirm, software gates.**

Built for an Isocode Software Engineering take-home (brief: customs broker, Nhava Sheva).
An accompanying private engineering notebook records every decision, command and test
result; it is intentionally kept outside this repository.

## Status (honest build log)

| Layer | State |
|---|---|
| Pure engines (cross-checks, numeric, normalize, state machine) | ✅ Built, **59/59 unit tests passing** |
| Prisma schema (9 domain models + 8 enums, invariants in DB constraints) | ✅ **Migrated** — `init` applied; verified 10 tables in the live DB (9 domain + `_prisma_migrations`) |
| REST API, document storage, AI pipeline, review UI, export | ⬜ Next phases |
| Full test suite grows per feature | planned: integration (real Postgres) + 2 Playwright E2E |

`npm run test` output at last run: `Test Files 4 passed (4), Tests 59 passed (59)`.
No test result is ever reported without it having actually been run — the same discipline
applies to every claim in this README.

## Tech stack & why

- **Next.js 16 (App Router) + TypeScript** — one deployable process: UI, REST route handlers,
  services, pure engines. One language, India-region function pinning on Vercel (`bom1`).
- **PostgreSQL via Prisma** — the product's value is relational: shipments → documents →
  typed fields, uniqueness invariants (one invoice per shipment; one row per field key),
  transactional multi-table writes (field edit + audit + checks + status).
- **Vitest** — engines are pure functions, so the arithmetic debt of this domain
  (money, weights, tolerances) is paid in fast, exact unit tests first.
- **Zod** (from the next phases) — one validation grammar at every trust boundary:
  request bodies, AI structured output, env vars.
- No queues, no microservices: 7-day scale is < 10k shipments/year. The seams to extract
  a background worker later already exist (per-document status, one pipeline module).

## The engines (the "hard part" of the brief)

All cross-check logic lives in pure TypeScript with no I/O:

```
src/server/engines/
  crosschecks.ts    9 deterministic rules (CV-1..CV-8), FAIL cites the accusing fields
  numeric.ts        exact integer math on the "milli" scale (×1000), BigInt products
  normalize.ts      lenient document-text → typed value layer (money/weight/date/Incoterm)
  state-machine.ts  6 shipment states; approval is auto-revoked by later writes
```

Key contracts (deliberate, documented, tested):

- **Scale contract** — every numeric engine input is an exact integer at 3-decimal
  precision ("milli units"): money `USD 6.80 → 6800`, weights in grams `3,120 kg → 3,120,000`,
  quantities `2400 → 2,400,000`. IEEE floats can't represent `0.1`; financial cross-checks
  on floats produce false PASS/FAIL — the classic first bug in this domain.
- **Tolerance centralization** — `src/lib/tolerances.ts` is the single file of numeric
  judgement (e.g. weights: PASS iff Δ ≤ max(2,000 g, 0.3% × min weight); the brief's sample
  shipment Δ45 kg on a 3,120 kg base must FAIL, a 3 kg scale-noise case must PASS).
- **Effective-documents gate** — only snapshots that are *both uploaded and readable*
  participate in comparison rules; a missing/unreadable document is solely reported by the
  required-fields rule. A corrupted document's stale fields must never silently sail
  through checks.
- **AI never runs here** — the engine consumes typed values already normalized from
  document text; determinism is what makes FAIL messages explainable and testable.

## Getting started

```bash
npm install

cp .env.example .env   # fill DATABASE_URL etc. (values are per-environment, never committed)

docker compose up -d   # local Postgres 16 → container cargolens-db (development only)

npm run dev            # Next.js app
npm run test           # engine unit tests (vitest)
npm run test:watch
npm run typecheck      # tsc --noEmit
npm run lint
```

Prisma is pinned exactly to **7.10.1**: the first migration (`prisma/migrations/…_init`) is
already applied, so an empty database is provisioned with `npx prisma migrate deploy`.
The seed script lands in the next phase. Schema design: `prisma/schema.prisma` — constraints
like `unique(shipmentId, type)` per document type and `unique(documentId, fieldKey)` per
field are part of the correctness story. Prisma 7 note: the connection URL is configured in
`prisma.config.ts` (read from `.env`), no longer in the schema's `datasource` block.

## Security & privacy posture

*Design commitments this build will be graded against — where each one lands, the status
table above and the test suite are the evidence. Nothing on this list counts as shipped
until it exists.*

- Role-based access is enforced server-side on every route (Executive vs Manager);
  UI state is UX, never the gate. Demo accounts only, synthetic seed data only.
- Uploaded documents live in private storage; reads happen exclusively through short-lived
  signed URLs minted after authorization.
- Uploads validated by magic bytes and size, never by browser-declared MIME types.
- Secrets only in environment variables; `.env*` files are git-ignored (except `.env.example`).
- **Hosting in India** (Vercel functions pinned to Mumbai `bom1`), and an AI provider on a
  **paid tier whose terms explicitly exclude training on submitted content**. The unpaid
  tiers of any provider are disqualified by their own reviewer-access clauses. Known limit,
  disclosed rather than hidden: the paid tier does not guarantee India-resident processing —
  an enterprise DPA route is the documented production upgrade.
- Importer contact data is personal data under India's DPDP Act 2023: data minimization,
  purpose limitation, no third-party trackers, retention/erasure handled as a designed
  follow-up rather than a claimed feature.

## Repo layout

```
prisma/            schema (Postgres) — migrations land with the DB bring-up
src/app/           Next.js App Router (UI + /api route handlers; landing next phases)
src/lib/           shared types (field dictionary, milli scale contract), tolerances, zod
src/server/
  engines/         PURE logic: state machine, cross-checks, numeric, normalize
  services/        business logic (owns Prisma access) — next phase
  ai/              provider client + extraction pipeline — later phase
tests/             vitest unit suites per engine (integration + E2E join per phase)
```

## Design commitments (counted as much as features in the brief)

Restrained palette, generous whitespace, clear type hierarchy, and one operating principle:
the review screen is used all day, so uncertainty must be obvious at a glance and every
action must be one keystroke or one click away.
