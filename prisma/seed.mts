/**
 * Seed CLI entry — `npm run seed` (→ `prisma db seed`, wired in prisma.config.ts)
 * or direct `npx tsx prisma/seed.mts`.
 *
 * `.mts` on purpose: tsx must emit ESM for top-level await (same lesson as
 * vitest.config.mts — CJS output crashes on it, notebook/10).
 *
 * Exit codes: 0 = seeded/ensured · 1 = guard refused (NO writes happened) ·
 * 2 = unexpected failure mid-run.
 */
import "dotenv/config";
import { runSeed } from "../src/server/seed/run";

async function main(): Promise<number> {
  try {
    const summary = await runSeed();
    console.log("SEED OK — synthetic demo data ensured (ADR-09):");
    console.log(JSON.stringify(summary, null, 2));
    console.log(
      "\nAll accounts and documents are labelled synthetic demo data; nothing here is client data.",
    );
    return 0;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.startsWith("SEED_REFUSED")) {
      console.error(msg);
      console.error("\nNo database writes occurred (the guard runs before any Prisma access).");
      console.error('Enable only by setting SEED_SYNTHETIC="true" in .env for the DEMO environment.');
      return 1;
    }
    console.error("Seed failed:", msg);
    console.error(e);
    return 2;
  }
}

process.exitCode = await main();
