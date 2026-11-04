/**
 * Pure unit tests for the seed guard — NO database, NO env loading: values are
 * stubbed straight into the function so the reject/accept ladder is proven
 * before the DB is ever touched.
 */
import { describe, expect, it } from "vitest";
import { assertSyntheticSeed, isSyntheticSeedFlag, SEED_REFUSED } from "@/server/seed/guard";

describe("seed guard — accepts exactly what it should", () => {
  it('accepts exactly "true"', () => {
    expect(() => assertSyntheticSeed("true")).not.toThrow();
    expect(isSyntheticSeedFlag("true")).toBe(true);
  });
});

describe("seed guard — rejects everything else (missing flag rejection)", () => {
  it("rejects an ABSENT flag", () => {
    expect(() => assertSyntheticSeed(undefined)).toThrow(SEED_REFUSED);
  });

  it("rejects null and empty string", () => {
    expect(() => assertSyntheticSeed(null)).toThrow(SEED_REFUSED);
    expect(() => assertSyntheticSeed("")).toThrow(SEED_REFUSED);
  });

  it("rejects near-miss values — no truthiness or case games", () => {
    expect(() => assertSyntheticSeed("TRUE")).toThrow(SEED_REFUSED);
    expect(() => assertSyntheticSeed("True")).toThrow(SEED_REFUSED);
    expect(() => assertSyntheticSeed("1")).toThrow(SEED_REFUSED);
    expect(() => assertSyntheticSeed("yes")).toThrow(SEED_REFUSED);
    expect(() => assertSyntheticSeed(" false")).toThrow(SEED_REFUSED);
    expect(() => assertSyntheticSeed("false ")).toThrow(SEED_REFUSED);
  });

  it("every rejection names itself and its policy (SEED_REFUSED prefix)", () => {
    try {
      assertSyntheticSeed("false");
      expect.unreachable("guard must have thrown");
    } catch (e) {
      expect((e as Error).message.startsWith(SEED_REFUSED)).toBe(true);
      expect((e as Error).message).toContain('SEED_SYNTHETIC must be exactly "true"');
    }
  });
});
