# CargoLens — Demo Instructions (synthetic data only)

> **No real customer documents.** Use only the synthetic fixtures/PDFs described here. **Live AI extraction is optional** and requires a billed, paid-tier `GEMINI_API_KEY` set server-side; if it’s not configured the extract route returns **503 before writing anything** (by design) — never faked. Automated verification of the extraction pipeline uses a deterministic, self-identifying **test-only stub** (documented in `TDD.md`), not live AI.

## 1) Start the app (reliable local demo)

```bash
docker compose up -d                 # Postgres (cargolens-db)
cp .env.example .env                 # set DATABASE_URL, BETTER_AUTH_SECRET, BETTER_AUTH_URL, SEED_DEMO_PASSWORD
npx prisma migrate deploy
SEED_SYNTHETIC=true npm run seed     # synthetic demo data (idempotent)

npm run build && npm run start       # production-mode (recommended) → http://localhost:3000
# (or `npm run dev` for development)
```

## 2) Sign in (demo roles)

| Role | Email | Capabilities |
|---|---|---|
| EXECUTIVE | `exec@demo.cargolens.in` | upload, extract, review/confirm/correct, resolve discrepancies, view/export when approved |
| MANAGER | `manager@demo.cargolens.in` | all of the above **+ approve** (manager-only) |

Password = the `SEED_DEMO_PASSWORD` you set (the sign-in page also shows demo credentials for the local demo). Roles are server-assigned.

## 3) Seeded shipments (synthetic ground truth)

- **SHP-24812** — clean: consistent invoice/packing list/B/L → zero blocking failures (the “ready for approval” story once fields are human-cleared).
- **SHP-24811** — planted discrepancy: invoice gross 3,120 kg vs packing list/B/L 3,165 kg (Δ45 kg) → **`GROSS_WEIGHT_CONSISTENCY` FAIL (BLOCKING)**. Demonstrates the gate, discrepancy detail (expected/actual/difference), and resolution-with-note.
- Seeded rows use `synthetic://` storage paths (no on-disk bytes), so their document **preview** is not the demo path — use an **uploaded** shipment (below) to show preview + the full upload→extract flow.

## 4) End-to-end walkthrough (upload → extract → approve → export)

1. **Sign in** as MANAGER.
2. **Create a shipment** (Dashboard → New shipment) or open SHP-24812.
3. **Upload 3 synthetic PDFs** (Invoice, Packing List, B/L). Content is magic-byte verified (not browser MIME), 10 MB max, one per type. Synthetic PDFs matching the fixture ground truth can be generated from `src/server/ai/synthetic-pdf.ts` (see `scripts/gen-e2e-docs.ts` pattern, run with `npx tsx`) — **never use real customer documents**.
4. **Extract with AI** — on each document tab click **Extract with AI** (explicit per document).
   - **Live (real AI):** set a billed, paid-tier `GEMINI_API_KEY` server-side and restart. Extracted fields show values with **confidence** (self-reported, guidance only) and **evidence** (page + verbatim excerpt). Audits record `EXTRACTION_*` with `via:"AI"` and the real provider name.
   - **No key configured:** the route returns **503 `PROVIDER_UNAVAILABLE` before any state change** and nothing is written — this is correct (manual entry remains available). The deterministic **stub is test-only** and refuses outside a test runtime; it is **not** a live-AI substitute and must not be presented as one.
5. **Review (human-in-the-loop):** open each tab’s document preview beside the **Extracted fields**. **Confirm** or **Correct** values (server-validated; rejections shown verbatim). Low-confidence fields are flagged. Add **manual entry** where needed. Confirmed/corrected/manual values are **never overwritten** by a re-extract.
6. **Cross-checks (deterministic):** the engine recomputes after every write. A BLOCKING FAIL cites the accusing fields and expected/actual/difference and **locks approval/export** until corrected or **resolved with a note**. (Open SHP-24811 to show a live `GROSS_WEIGHT_CONSISTENCY` block and the 409-on-approve gate.)
7. **Approve:** when status reaches **Ready for approval** (no unresolved blocking fails and required fields human-cleared), a **MANAGER** approves. (AI drafts alone cannot reach approval — the human-clearance gate holds.)
8. **Export CSV:** on an approved shipment, generate/download the gated `cargolens-csv-v1` export (deterministic, re-downloadable).
9. **Audit trail:** open the **Audit trail** tab to see the append-only, verbatim history (extraction started/completed with provider, confirmations/corrections, check recomputes, resolution, approval, export).

## 5) What to point out (maps to the brief)

- **Gated workflow:** server-enforced state machine + deterministic engine; export impossible with unresolved blocking issues / uncleared required fields (409s name the criteria). EXPORTED is terminal.
- **Human-in-the-loop:** AI drafts with confidence+evidence; humans confirm/correct; corrections preserved across re-extraction.
- **Deterministic checks:** pure engine, explainable FAILs (expected/actual/difference, accusing fields).
- **Auditability:** append-only events, provider self-identified (real vs stub never confusable).
- **Privacy:** private, magic-byte-verified uploads served via authorized short-lived signed tokens (no public URLs); AI key server-side only, paid tier (no training) — residency disclosed; synthetic data only.

## 6) Known demo constraints

- **Live AI needs a billed `GEMINI_API_KEY`.** Unset ⇒ 503 (honest). Do not claim a live run without it.
- Seeded `synthetic://` docs have no stored bytes → their preview 500s; upload real synthetic PDFs to demo preview+extract.
- For a hosted (non-local) demo, configure **persistent private** object storage (not ephemeral disk) — see `deployment.md`. Local production-mode (`next start`) with `STORAGE_DIR` is the verified reference demo.
