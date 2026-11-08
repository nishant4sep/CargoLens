# CargoLens

Human-in-the-loop import-documentation workbench for a customs broker. Upload a shipment's **Commercial Invoice**, **Packing List**, and **Bill of Lading** → an AI provider **drafts** fields (with self-reported confidence and page/excerpt evidence) → **deterministic code** runs cross-document checks → an executive confirms or corrects values against the document → a manager approves → CSV export is **impossible from the server** until every required field is human-cleared and every blocking check is resolved. Every meaningful action lands in an append-only audit ledger.

> **The rule:** AI drafts, code validates, humans confirm, software gates. The human confirmation is authoritative; the export gate is enforced server-side (state machine + engine), never by the UI.

Built for the Customs Broker Document Extraction & Cross-Check take-home (Company A, Nhava Sheva). Synthetic demo data only — no real customer documents.

## Reviewer Quick Start

| Role | Email | Password | Allowed Capabilities |
|---|---|---|---|
| **EXECUTIVE** | `exec@demo.cargolens.in` | `CargoLens-Demo-2026!` | Upload documents, trigger AI extraction, review/correct fields, manual entry, draft WhatsApp importer queries, resolve checks |
| **MANAGER** | `manager@demo.cargolens.in` | `CargoLens-Demo-2026!` | All executive capabilities **+ approve shipment** (manager-only gate), revoke approval, export CSV |

## Features (implemented)

- **Auth & roles:** email/password via `better-auth` (Prisma adapter). Roles `EXECUTIVE` / `MANAGER` are server-assigned; manager-only approval, export gated by server state/engine.
- **Shipments:** create/list (status filter + ref search), detail aggregate (docs, fields, line items, checks, approval, latest export, metrics).
- **Private document storage:** content-sniffed upload (PDF/JPEG/PNG magic bytes, never browser MIME), 10 MB, per-type uniqueness (409), randomized storage names, sha256; files served only through an authorized, short-lived signed file token — no public URLs. Local-disk seam today (`STORAGE_DIR`), swappable to private object storage for production.
- **AI extraction (Phase 5, committed):** explicit per-document “Extract with AI” (`POST /api/documents/:id/extract`). Provider seam (`RawExtractionSchema` strict over the 19-key dictionary — no invented keys/sums; confidence ∈ [0,1], self-reported/not a gate; page + verbatim excerpt evidence; `null` absent, `unreadable` explicit). Gemini REST provider (no SDK): key in `x-goog-api-key` header (never URL/log/response), structured JSON output, `temperature: 0`, 120s timeout, transient retry/backoff, a transcription-only prompt (NEVER calculates — the cross-check engine owns arithmetic). A deterministic, **test-only** stub (self-identifies `NOT AI`, refuses outside a test runtime) powers automated tests; it never masquerades as AI.
- **Extraction guarantees:** 503 (with nothing written) when unconfigured; machine-audited claim (`EXTRACTION_STARTED`); provider I/O outside transactions; schema-validate + one repair retry; the **AI layer is replaced wholesale** on re-run while `CONFIRMED/CORRECTED/MANUAL_ENTERED` rows are **never overwritten**; values normalized through the existing strict normalizer (never guessed; unparseable reported, not stored); whole-doc unreadable → terminal, workflow continues via manual entry; provider failure → `FAILED` + audited + retryable (never a zombie); 15-min stale-PROCESSING guard; the same terminal-count/DOCS_REACHED_TERMINAL/recompute ladder as manual entry. Recomputes cross-checks; audits record `via:"AI"` + provider name.
- **Deterministic cross-checks (9 rules):** required fields, line arithmetic, invoice total vs line sum, quantity match (invoice↔packing list), package counts (packing list↔BOL), gross-weight consistency (tolerance-based), net≤gross, container consistency (ISO 6346 form + cross-doc), currency consistency. Pure engine, FAIL cites accusing fields; unresolved BLOCKING fails lock approval/export.
- **Review UI:** side-by-side document preview (signed file), extracted fields with confidence (low-confidence flagged) and evidence excerpt/page, confirm/correct (server-validated; 422 shown verbatim), manual entry, resolve BLOCKING check with a note, deterministic check results with expected/actual/difference.
- **Manager approval & gated export:** approve only from `READY_FOR_APPROVAL` (manager-only); export only when approved and engine-clean (`cargolens-csv-v1`, deterministic, re-downloadable). `EXPORTED` is terminal for writes.
- **Audit trail & reporting:** append-only audit of extraction, confirmations/corrections, check recomputes, resolutions, approval, export — rendered verbatim. Accuracy/workload report (correction/workload/blocking/open counts) with honest metrics (no fabricated “AI accuracy”; verified accuracy empty until a labeled ground-truth corpus exists).

## Tech stack

- **Next.js 16.4.5** (App Router, Turbopack) + **React 19** + **TypeScript** — UI, route handlers, services, pure engines in one process.
- **PostgreSQL** + **Prisma 7.10.1** (`@prisma/adapter-pg`) — relational model (shipments→documents→typed fields/line items, checks, audits, exports) with uniqueness/enum/decimal constraints.
- **better-auth 1.7.16** (Prisma adapter) — session auth, server-assigned roles.
- **Zod** — validation at trust boundaries (DTOs, AI response schema).
- **Vitest** — pure + integration suites.
- **Tailwind v4** — restrained UI.

## Architecture (high level)

```
src/app/                 App Router pages + REST route handlers (thin: auth → service → envelope)
  (app)/shipments/...    review screen, dashboard, accuracy report
  api/...                row-1..19 style endpoints (shipment, upload, extract, review, approve, export, audit)
src/components/          client components (upload, extract button, fields/preview, approval/export, manual entry)
src/lib/                 shared types (19-key field dictionary + kinds), tolerances, envelope/format helpers
src/server/
  engines/               PURE: crosschecks, normalize, numeric (milli/BigInt), state-machine
  services/              business logic (Prisma + audits + state transitions): shipments, review, extract, approve, export
  ai/                    provider seam + RawExtractionSchema + gemini REST + test-only stub + synthetic PDFs
  storage.ts             PRIVATE storage seam (local disk; swap to object storage) + signed file tokens
  http.ts, dto.ts        error envelope, auth, Zod DTOs
prisma/schema.prisma     9 domain models + enums, migrations
tests/engines,tests/ui   pure tests (no DB)
tests/integration        real-Postgres tests (sequential files)
```

Key seams: `server/storage.ts` (local → private object storage), `server/ai/provider.ts` (Gemini → other paid, DPA-backed provider), `server/engines/*` (pure, no I/O).

## Setup (local)

**Prereqs:** Node 20+, Docker (for local Postgres).

```bash
npm install
cp .env.example .env
# fill DATABASE_URL, BETTER_AUTH_SECRET (>=32 chars), BETTER_AUTH_URL=http://localhost:3000,
# SEED_DEMO_PASSWORD (and GEMINI_API_KEY only when running a live extraction — see below)

docker compose up -d                         # Postgres → cargolens-db (dev only)
npx prisma migrate deploy                    # apply migrations
SEED_SYNTHETIC=true npm run seed             # idempotent synthetic demo data (refuses if not true)

npm run dev                                  # http://localhost:3000
# production-mode local run (reliable demo): npm run build && npm run start
```

**Demo accounts (created by seed):** `exec@demo.cargolens.in` (EXECUTIVE) and `manager@demo.cargolens.in` (MANAGER). The sign-in page displays demo credentials for the local demo; the password is the `SEED_DEMO_PASSWORD` you set (never committed). Roles are server-assigned.

## Demo workflow (synthetic data only)

1. Sign in (manager or executive).
2. Create a shipment (or open seeded `SHP-24811` / `SHP-24812`).
3. Upload the 3 synthetic PDFs (Invoice, Packing List, B/L). A deterministic generator (`src/server/ai/synthetic-pdf.ts`) builds them from fixture ground truth — no real customer documents.
4. On each document tab, click **Extract with AI** (explicit; no auto-run). _Live Gemini requires a billed `GEMINI_API_KEY` set server-side and a paid tier whose terms exclude training on submitted content — otherwise the route returns **503** before writing anything; never faked. The deterministic stub is **test-only** and self-identifies._
5. Review extracted fields (confidence + evidence excerpt/page), confirm or correct against the document preview; resolve any BLOCKING discrepancy with a note.
6. When the shipment reaches **Ready for approval**, a **MANAGER** approves.
7. Generate/download the **CSV export** (gated; `cargolens-csv-v1`).
8. Inspect the **Audit trail** (extraction events show `via:"AI"` + provider name) and the **Accuracy/workload report**.

Seed facts: `SHP-24812` is the clean, zero-blocking story; `SHP-24811` carries the planted 45 kg gross-weight discrepancy (`GROSS_WEIGHT_CONSISTENCY` FAIL) so the gate/resolve flow is exercisable.

## Tests

```bash
npm run test        # pure suites (no DB): engines, seed fixtures, UI helpers
npm run test:seed   # integration (real Postgres, sequential) — needs cargolens-db healthy
npm run typecheck   # tsc --noEmit
npm run build       # production build
```

Current status (verified in this repo state): **typecheck clean; production build clean; pure 14 files / 182 tests pass; integration 10 files / 128 tests pass** (against local Docker Postgres, synthetic data). See `TDD.md` for the strategy, coverage, and known gaps.

## Security & privacy posture

- **AuthZ server-side:** every route checks the session; role checks on manager actions; UI is never the gate. The state machine + engine gate approval/export.
- **Private documents:** magic-byte sniffed, size-limited, randomized names, sha256; read only via a short-lived signed token minted after authorization; no public object URLs. Production must use **persistent private** object storage (never ephemeral container disk).
- **AI data handling:** the live provider is called server-side; the API key is read from env and sent in a header — never exposed to the browser, never logged, never committed. **Paid tier only** (unpaid tiers permit training/reviewer access — rejected). **Residency is not guaranteed in-India** by the paid API tier; disclosed honestly — the production upgrade is an enterprise DPA / in-region processing path (e.g., Vertex AI / Azure OpenAI) under a client-signed DPA. See `deployment.md`.
- **DPDP-minded:** synthetic demo data only, data minimization, no third-party trackers. Retention/erasure is a documented follow-up, not a claimed shipped feature.
- **Secrets:** `.env*` git-ignored (except `.env.example`); no keys in source/logs/responses.

## Deployment

See **`deployment.md`** for the full runbook (env vars, migrations, persistent private storage, India-region hosting, build/start, troubleshooting) and an honest note on what was/wasn’t provisioned in this environment. **Do not** deploy with ephemeral document storage or public file URLs.

## Known limitations

- **Live Gemini extraction requires a billed, configured `GEMINI_API_KEY`** (and model/params verified at run time). In this repo state it is unconfigured → the route returns 503 (by design, nothing written). Automated tests prove the pipeline via a deterministic, self-identifying, test-only stub — **never** represented as live AI output.
- **AI is probabilistic:** confidence is self-reported (guidance, never a gate); the model may miss/misread fields — hence mandatory human confirmation and deterministic checks. No arithmetic delegated to the model.
- **In-region processing not guaranteed** by the paid API tier (training excluded) — disclosed; enterprise DPA path documented.
- Seeded documents use synthetic `synthetic://` storage paths (no real bytes) — the upload→extract flow on real PDFs is the verified path for user uploads.
- Single-process, sync extraction (sufficient at this scale); a background job variant is the documented scale-up path. No cross-region failover.

## Documentation

- `TDD.md` — test strategy, suites, verification evidence, gaps.
- `deployment.md` — deployment runbook and env/storage/region notes.
- `DEMO.md` — step-by-step demo walkthrough and roles.
- `prisma/schema.prisma` — data model & constraints.
