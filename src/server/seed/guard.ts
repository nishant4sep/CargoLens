/**
 * The seed guard — designed NEGATIVE-FIRST (isocode-preparation/12, Entry 4):
 * refusing to write is the DEFAULT; only an explicit, exact "true" unlocks the
 * demo dataset (ADR-09: synthetic demo data only — never real client documents).
 *
 * Deliberately PURE (no prisma, no better-auth, no env reading): the module that
 * protects the database must be provable WITHOUT a database. Tests stub values
 * directly; callers pass process.env.SEED_SYNTHETIC explicitly.
 */

export const SEED_REFUSED =
  "SEED_REFUSED: refusing to write demo data to this database";

export function isSyntheticSeedFlag(flag: string | undefined | null): boolean {
  // Exact match only: no truthiness games ("1", "TRUE", "yes" all reject).
  return flag === "true";
}

export function assertSyntheticSeed(flag: string | undefined | null): void {
  if (!isSyntheticSeedFlag(flag)) {
    throw new Error(
      `${SEED_REFUSED} — SEED_SYNTHETIC must be exactly "true". Anything else ` +
        "means this run is not proven to be the synthetic demo environment " +
        "(ADR-09: demo data only, never real client documents).",
    );
  }
}
