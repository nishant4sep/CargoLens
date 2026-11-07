# CargoLens — Test Design & Verification (TDD)

> Principle: **no claim without a run.** Every result below was executed in this repo state (local Windows dev, Docker Postgres `cargolens-db`, Node 20+). Live Gemini extraction is **BLOCKED** (no billed `GEMINI_API_KEY` configured) and is **not** claimed as verified.

## 1) Strategy

| Layer | Goal | How | DB? |
|---|---|---|---|
| **Pure (unit)** | Prove deterministic engines, parsing/normalization, state machine, schema validation, UI/pure helpers — exact, fast, no I/O | Vitest (`vitest.config.mts`) over `tests/**` excluding `tests/integration/**` | No |
| **Integration** | Prove the real routes/services/Prisma/state machine/audits/gates against a real Postgres with synthetic data | Vitest (`vitest.integration.config.mts`, sequential files) hitting Next route handlers + services | Yes (Docker `cargolens-db`) |
| **Build / typecheck** | Prove the app compiles as shipped | `tsc --noEmit`, `next build` (Turbopack) | No |
| **HTTP / runtime E2E (service-path)** | Prove the end-to-end ladder through real services/routes with real audits, deterministically | Scripted calls to the real `extractDocument` service + authenticated HTTP routes (see §4) using the **test-only, self-identifying stub** (not AI) | Yes |
| **Browser verification** | Confirm key screens render and the gated flows are operable | Manual/browser run against the **production build** (`next build && next start`); see §4/§6 | Yes |

**AI honesty rule:** automated and scripted extraction evidence uses the deterministic stub, which **self-identifies** as `stub-text-reader (deterministic, NOT AI)` in its provider name and in every `EXTRACTION_*` audit payload, and **refuses to construct outside a test runtime**. It is never represented as live AI output.

## 2) Suites & coverage

### 2.1 Pure (14 files, 182 tests) — `npm run test`

- `tests/engines/crosschecks.test.ts` — the 9 deterministic rules (CV-1..CV-8 family), tolerances, effective-documents gating, FAIL cites accusing fields; planted SHP-24811 45 kg discrepancy fails `GROSS_WEIGHT_CONSISTENCY`, clean case passes.
- `tests/engines/numeric.test.ts`, `tests/engines/normalize.test.ts` — milli/BigInt arithmetic, money/weight/date/Incoterm parsing; **never-guess** (unknown units / prose refused).
- `tests/engines/state-machine.test.ts` — 6 shipment states, allowed/denied transitions, approval auto-revoked by later writes, terminal EXPORTED.
- `tests/engines/csv.test.ts` — deterministic `cargolens-csv-v1` layout/integrity.
- `tests/engines/extraction-ai.test.ts` (**22, Phase 5**) — `RawExtractionSchema` strict where it guards honesty (unknown field keys rejected, confidence bounds [0,1] incl. edges, integer pages ≥1, extra keys rejected) and lenient in (long excerpts trimmed to 120); null/unreadable representable; synthetic PDF generator builds valid PDFs and escapes fixture text; **stub** self-identifies (NOT AI), reads clean invoice/line items/weights against **hand-written ground truth**, treats no-label pages as `documentUnreadable` (never invents), marks `ILLEGIBLE` unreadable with null+low confidence; stub **refuses outside a test runtime**; `getProvider()` throws `ProviderUnavailableError` with no key (503, never a fake run); raw extraction values through the existing strict normalizer (money/weight/unit-unknown/prose refused) — the honesty bridge.
- `tests/seed/fixtures.test.ts`, `tests/seed/guard.test.ts` — synthetic fixture integrity, seed guard.
- `tests/ui/*` — `review-helpers` (formatting, confidence, machine-derived permissions, check-detail rendering incl. real engine payloads, `extractAction` eligibility, approval/export gates, readiness, audit rendering), `dashboard/format/envelope/submit-guard/accuracy-helpers`.

### 2.2 Integration (10 files, 128 tests) — `npm run test:seed`

Runs sequentially (`fileParallelism:false`) against real local Postgres with synthetic data. Requires Docker `cargolens-db` healthy.

- `tests/integration/seed-idempotency.test.ts` — idempotent, additive seed; guard; derived statuses via the real state machine.
- `tests/integration/auth-flow.test.ts` — login/session/role surfaces.
- `tests/integration/api.test.ts` — core CRUD/contracts/envelope behavior.
- `tests/integration/upload.test.ts` — magic-byte sniff (not MIME), 413/409, randomized storage, sha256, orphan cleanup on failure, EXPORTED write refusal.
- `tests/integration/dashboard.test.ts` — list/filter/search, blocking counts.
- `tests/integration/manual-entry-draft.test.ts` — D-1b ladder (DRAFT first entry → `EXTRACTION_STARTED`; last terminal → `DOCS_REACHED_TERMINAL`/recompute; clean → READY; mismatch CV-6 holds; EXPORTED 409), typed-column persistence.
- `tests/integration/review-workflow.test.ts` — confirm/correct/resolve, recompute, state transitions, gates.
- `tests/integration/approval-export.test.ts` — manager-only approve, READY gate, gated deterministic export, re-download, terminal/blocked cases.
- `tests/integration/accuracy-report.test.ts` — report endpoints/aggregations over synthetic data.
- `tests/integration/extract.test.ts` (**14, Phase 5**) — the real row-9 pipeline (stub-labeled): **401/404/409** (in-flight + EXPORTED)/**503** (no provider, and **nothing changes** — no claim/audit/status); happy ladder with **ground-truth milli assertions** (e.g. `totalValue` 7650 EUR, `invoiceDate` 2024-03-14, line 180×42.5=7650 — read from the page, **no arithmetic**; `AI_DRAFT`, `confirmedById=null`, confidence/excerpt/page present; absent keys not invented); provider **self-identifies** in audits; partial completion (no `DOCS_REACHED_TERMINAL`); last-doc ladder → `NEEDS_REVIEW` (AI drafts cannot approve) → human confirm → `READY_FOR_APPROVAL`; re-extract re-opens and **replaces the AI layer wholesale** while **CONFIRMED rows are skipped** (stale AI_DRAFT purged, not duplicated); **provider failure = handled outcome** (doc `FAILED` + `EXTRACTION_FAILED` audited + `extractError`, 200, retryable, **never a 500/zombie**) then retry succeeds; **15-min PROCESSING zombie** re-runnable; whole-doc `UNREADABLE` is terminal for the doc but **manual entry completes the workflow**; AI+manual mix → engine grades AI values (**CV-6 `GROSS_WEIGHT_CONSISTENCY` blocks**, approve 409); **human CORRECTED value survives re-extraction byte-identically** (skipped; sibling re-drafted); no regression to READY→APPROVED→export and EXPORTED refuses extraction (409).
- Test-isolation hardening (this audit): `api.test.ts` precondition lookups made self-contained (create their own DRAFT / no-export shipment) and `seed-idempotency` global counts made resilient to non-destructive stray rows in a shared dev DB, so `npm run test:seed` remains reliable without weakening invariants.

## 3) Executed results (this repo state)

| Check | Command | Result |
|---|---|---|
| Typecheck | `npm run typecheck` | **clean** (`tsc --noEmit`) |
| Production build | `npm run build` | **clean** (Next 16.4.5 Turbopack; route tree generated) |
| Pure tests | `npm run test` | **14 files / 182 tests — all pass** |
| Integration tests | `npm run test:seed` | **10 files / 128 tests — all pass** (Docker `cargolens-db` healthy) |

> Reproduce: `docker compose up -d` → `npx prisma migrate deploy` → `npm run test` and (with DB healthy) `npm run test:seed` → `npm run build`.

## 4) End-to-end verification evidence

- **Service/route E2E (real, stub-labeled, not faked):** on a fresh DRAFT shipment (`SHP-202611-01`) with 3 synthetic SHP-24812 PDFs uploaded through the **real upload route**, the **real `extractDocument` service / row-9 path** (provider = `stub-text-reader (deterministic, NOT AI)`) produced INVOICE/PL/BOL `PROCESSED` with grounded field/line counts and reached **`NEEDS_REVIEW`** (21 AI_DRAFT fields; clean, zero blocking fails — held by the human-clearance gate, by design). Then, via the **real authenticated HTTP routes**: 21 field confirms → **`READY_FOR_APPROVAL`** → `POST /approve` **200 `APPROVED`** → `POST /export` **201**. The **audit trail** (API) recorded `EXTRACTION_STARTED`, 3×`EXTRACTION_COMPLETED` (with `via:"AI"`/provider), 21×`FIELD_CONFIRMED`, `APPROVAL_GRANTED`, `EXPORT_GENERATED` — all real events. _No live AI output was used; the provider is self-identified stub._
- **Browser (production build):** `next build` + `next start` (port 3001) served the review page for a seeded shipment (`SHP-24811`, NEEDS_REVIEW, PROCESSED docs) with the **review grid, “Re-run AI extraction” (AI extraction) block, “Extracted fields”, and “Manual entry” present** in the rendered HTML (HTTP 200; markers verified). The earlier “grid missing” observation was confined to destabilized Turbopack **dev** sessions (mid-edits/cache churn) and **did not reproduce** on a clean dev restart or on the production build — **not a source regression**; no blind patch applied. (Note: seeded docs carry `synthetic://` storage paths with no on-disk bytes, so the file-preview fetch 500s for seeded fixtures; the upload→real-bytes path is verified by integration/upload tests and the HTTP E2E above.)
- **Gates verified (integration + HTTP):** unresolved BLOCKING discrepancy → approve **409** naming the check (e.g. `GROSS_WEIGHT_CONSISTENCY`); AI drafts alone cannot reach approval (human clearance required); EXPORTED refuses extraction/writes (409).

## 5) Live-provider (Gemini) — status

**BLOCKED, not run, not faked.** `GEMINI_API_KEY` is not configured in `.env`. The row-9 service returns **503 `PROVIDER_UNAVAILABLE` before any state change** when unconfigured (proven by integration). The Gemini REST provider is implemented (key in header, structured output, no arithmetic, 120s timeout, transient retry, one schema-repair retry, no secrets/bytes in errors) with a parameterized model (`GEMINI_MODEL`, default `gemini-2.5-flash`) to be **re-verified against the live model/params** at run time. A live run, if/when a **billed, paid-tier** key is supplied server-side, must: confirm terms exclude training on submitted content, record latency/errors/approx cost if available, compare to fixture ground truth, and report **live vs stub** separately. None of that is claimed here.

## 6) Known gaps / limitations

- No automated **live** Gemini extraction (blocked on key + paid tier); model quality against real scans is uncharacterized — confidence is self-reported (guidance only) and human confirmation is mandatory.
- Browser checks were performed against the production build and HTTP routes; no committed Playwright suite in this snapshot (pure + integration + build + prod-render + HTTP E2E cover the critical paths). A Playwright pass clicking the UI controls end-to-end is a recommended follow-up.
- Seeded fixtures reference `synthetic://` (no stored bytes) so their document preview 500s — by design of the seed; user-uploaded real bytes are the supported preview/extract path.
- `next start` logged benign prerender/fetch warnings under Next 16 cache-components behavior on a dynamic route; page responses were correct (200, full content). Treat as a polish item, not a functional failure.
- Line-item extraction is best-effort (unparseable qty → line skipped/reported); whole-AI-layer replacement on re-run (human statuses preserved) — as designed.
- In-region (India) AI processing is **not guaranteed** by the paid API tier (training excluded); residency is a disclosed deployment concern (enterprise DPA / in-region path documented in `deployment.md`).
