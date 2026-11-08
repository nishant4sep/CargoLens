# CargoLens — Deployment & Operations

This runbook covers local production-mode operation and the path to a hosted, India-region deployment.

## Reviewer Demo Login Details

| Role | Email | Demo Password | Capabilities |
|---|---|---|---|
| **EXECUTIVE** | `exec@demo.cargolens.in` | `CargoLens-Demo-2026!` | Upload documents, trigger AI extraction, review/confirm/correct fields, manual entry fallback, resolve check discrepancies |
| **MANAGER** | `manager@demo.cargolens.in` | `CargoLens-Demo-2026!` | All executive actions **+ approve shipment** (manager-only gate), revoke approval, export CSV |

*Note: Roles are server-assigned and strictly enforced at the API and database levels.*

## 1) Environment variables

Copy `.env.example` → `.env` (never commit `.env`). All secrets are env-only.

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | Postgres connection string (Prisma). Production: a managed Postgres (ideally India region — see §3). |
| `BETTER_AUTH_SECRET` | yes | ≥32 random chars. `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `BETTER_AUTH_URL` | yes | App base URL (`http://localhost:3000` dev; your `https://…` origin in prod — must match the deployed origin for auth callbacks/cookies). |
| `SEED_DEMO_PASSWORD` | for demo seed | Password for the synthetic demo accounts (set it; never hardcoded/committed). |
| `SEED_SYNTHETIC` | for seed | `true` to allow the synthetic seed; the seed **refuses** unless `true` (guard against seeding a real DB). |
| `GEMINI_API_KEY` | for **live** AI only | Billed, **paid-tier** Gemini key (server-side only; sent in `x-goog-api-key` header, never logged/exposed). **Unset/empty ⇒ extraction returns 503 before any state change** (by design). |
| `GEMINI_MODEL` | optional | Overrides the model id (default `gemini-2.5-flash`); **verify model/params against the live API** at run time. |
| `EXTRACTION_PROVIDER` | test only | `stub` selects the deterministic test provider — **refused outside a test runtime** (`VITEST`/`NODE_ENV=test`), so it cannot fake production extraction. Do **not** set in production. |
| `STORAGE_DIR` | local disk | Local private storage directory (default `./.storage`). **Dev/local only** — see §4. |
| `STORAGE_URL` | prod object storage | Reserved for the private object-storage driver (e.g., Supabase project URL). |
| `STORAGE_SERVICE_ROLE_KEY` | prod object storage | Reserved for the private object-storage service key (server-side only). |

## 2) Build, migrate, seed

```bash
npm ci                      # or npm install (lockfile present)
npm run typecheck           # tsc --noEmit
npm run build               # next build (Turbopack) — must be clean

npx prisma migrate deploy   # apply migrations to DATABASE_URL (never use migrate dev against prod)

# Demo data (synthetic only) — run ONLY against a demo database:
SEED_SYNTHETIC=true SEED_DEMO_PASSWORD=<your-demo-password> npm run seed
# idempotent/additive; creates exec@demo.cargolens.in (EXECUTIVE) and manager@demo.cargolens.in (MANAGER)
# with the password you set, plus SHP-24811 (planted 45 kg discrepancy) and SHP-24812 (clean).

npm run start               # production server (defaults :3000; use -p to change)
```

**Reliable local demo (verified):** `docker compose up -d` → migrate → seed → `npm run build && npm run start` → open `http://localhost:3000`. The production build served the full review/extraction/approval/export/audit flow correctly in verification.

## 3) Hosting — India-region target (recommended)

Goal: app compute + database + document storage in/near India, secrets server-side, documents private.

| Component | Recommendation (7-day / prototype) | Verified notes (see `isocode-preparation/07-DEPLOYMENT-EXPLAINED.md`) | Action at deploy time |
|---|---|---|---|
| **App** | **Vercel** project, functions pinned to **Mumbai `bom1` (ap-south-1)** | `bom1` is a documented, settable region (`vercel.json` `"regions":["bom1"]`). | Set env vars in Vercel; `BETTER_AUTH_URL` = deployed origin. Confirm Hobby/plan region limits. |
| **Postgres** | **Supabase** project, pick **Mumbai/ap-south-1** if offered | Region is chosen in the dashboard at creation — **verify/screenshot at creation** (offline docs were inconclusive). Fallbacks: managed PG on an India-region VM, or AWS RDS `ap-south-1`. | Put connection string in `DATABASE_URL`; run `prisma migrate deploy`; seed demo DB only with `SEED_SYNTHETIC=true`. |
| **Object storage** | **Supabase Storage, private bucket**, same project/region | Keep bucket **private**; never issue public URLs. | Implement the Supabase driver behind `src/server/storage.ts` (see §4) using `STORAGE_URL`/`STORAGE_SERVICE_ROLE_KEY`; serve bytes only via the existing authorized signed-token route. |
| **AI (live)** | Gemini **paid tier** (billing project) or an enterprise/DPA provider | Paid tier: prompts/files/responses **not used to improve products** (terms verified). **Unpaid tiers are disqualified**. **India data-residency is NOT guaranteed** by the paid API tier (cached/processed per provider facilities) — disclose; production upgrade = enterprise DPA / in-region processing (e.g., Vertex AI / Azure OpenAI) under a client-signed DPA. | Set `GEMINI_API_KEY` server-side; verify `GEMINI_MODEL`/params live; confirm paid-tier terms. |

**This environment:** no cloud credentials were available, so no hosted URL is claimed. The runbook above is complete and the app is deploy-ready subject to (a) wiring the persistent private storage driver (§4), (b) provisioning the managed services with your credentials, and (c) supplying a billed AI key for live extraction.

## 4) Document storage — production requirement

> **Never use ephemeral container/filesystem storage for uploaded documents in production. Never expose documents via public URLs.**

Current seam: `src/server/storage.ts` implements `putDocument` / `openDocument` / `removeDocument` over a **local private directory** (`STORAGE_DIR`, default `./.storage`) with randomized names and an authorized short-lived signed file token served by `/api/files/[token]`. This is correct for local/dev and **not durable** on serverless/ephemeral hosts.

**To productionize (keeps the same contract):**
1. Add a driver in `src/server/storage.ts` (or a sibling) that, when `STORAGE_URL`/`STORAGE_SERVICE_ROLE_KEY` are set, stores/reads objects in a **private** bucket (e.g., Supabase Storage) instead of disk; keep randomized keys, record sha256/size, and never return a public URL.
2. Continue serving bytes **only** through the existing authorized, short-lived signed-token endpoint (`/api/documents/:id/file` → `/api/files/[token]`) so access remains authenticated and time-bounded.
3. Verify: upload, preview, and the extraction service’s `openDocument` read the bytes from the private bucket; delete-on-orphan still runs.

Until this is wired, treat any non-local deployment as **incomplete for document persistence** and do not point real users at it.

## 5) Database migrations & demo data

- Migrations live in `prisma/migrations` (Prisma 7.10.1; connection configured in `prisma.config.ts`). Apply with `npx prisma migrate deploy` against the target `DATABASE_URL`.
- The seed is **idempotent/additive** and **guarded**: it refuses unless `SEED_SYNTHETIC=true`. It creates synthetic demo accounts/shipments only. **Never run the synthetic seed against a database holding real client data.** Demo passwords come from `SEED_DEMO_PASSWORD` (env), never source.
- Seeded fixtures store `synthetic://` paths (no bytes) — they demonstrate statuses/checks; the **upload → real-bytes → extract** path is the one to demo for user uploads.

## 6) Verification checklist (run after deploy)

1. `GET /login` loads over HTTPS at the deployed origin; sign in as manager and executive (cookies scoped to `BETTER_AUTH_URL`).
2. Create a shipment → upload 3 synthetic PDFs → per-doc **Extract with AI**.
   - With a billed `GEMINI_API_KEY`: fields draft with confidence/evidence; audits show `EXTRACTION_*` with the real provider name.
   - Without a key: **503 `PROVIDER_UNAVAILABLE` before any state change** (expected, not a bug) — manual entry remains available.
3. Confirm/correct fields, resolve a BLOCKING discrepancy (SHP-24811 scenario) → **READY_FOR_APPROVAL**.
4. Manager approves → CSV export downloads (gated; `cargolens-csv-v1`). Confirm re-download and the **audit trail** (extraction/confirm/approval/export events).
5. Confirm uploaded documents are **not** publicly accessible and survive a process restart/redeploy (proves persistent private storage). Confirm no secrets in client bundles/logs.

## 7) Troubleshooting

- **Auth redirect/cookie issues:** `BETTER_AUTH_URL` must exactly match the deployed origin (scheme/host/port); `BETTER_AUTH_SECRET` set and stable.
- **Prisma / `DATABASE_URL`:** verify connectivity and that `migrate deploy` ran; Prisma 7 reads the URL via `prisma.config.ts` + the pg adapter.
- **Extraction 503:** `GEMINI_API_KEY` unset/empty — by design (no writes). Set a billed key server-side. **409:** doc in-flight (fresh <15 min) or shipment EXPORTED — by design.
- **`[storage] file missing` / preview 500:** the DB row references bytes not present in `STORAGE_DIR`/bucket (common for seeded `synthetic://` fixtures, or ephemeral disk after redeploy). Fix by using persistent private storage (§4) and re-uploading real files.
- **Build/type issues:** `npm run typecheck && npm run build` must be clean; ensure Node 20+ and `npm ci` from the lockfile.
- **Turbopack root warning (monorepo-ish home dir):** harmless; set `turbopack.root` / `outputFileTracingRoot` in `next.config.ts` if desired.

## 8) Security reminders

- Paid AI tier only (unpaid tiers permit training/reviewer access). Residency not guaranteed — disclose; DPA/in-region path for production. Key stays server-side, header-only, never logged.
- Private bucket + signed, authorized, short-lived file access; no public document URLs. Magic-byte + size validation on upload.
- Roles and the export/approval gates enforced server-side (state machine + engine). `EXPORTED` terminal.
- No real customer documents in the repo or demo; `.env` git-ignored. Rotate any key that is ever exposed.
