import { describe, expect, it } from "vitest";
import {
  milliToDisplay,
  mulMilli,
  toMilliStrict,
  weightToleranceMilliKg,
} from "@/server/engines/numeric";

describe("toMilliStrict", () => {
  it("converts plain decimals exactly", () => {
    expect(toMilliStrict("6.80")).toBe(6800);
    expect(toMilliStrict("16320")).toBe(16320000);
    expect(toMilliStrict("0.003")).toBe(3);
    expect(toMilliStrict("-16320.05")).toBe(-16320050);
  });

  it("accepts comma-only thousands grouping", () => {
    expect(toMilliStrict("1,234.5")).toBe(1234500);
    expect(toMilliStrict("-1,234")).toBe(-1234000);
  });

  it("rejects decimal commas at the STRICT layer (normalize layer owns ambiguity)", () => {
    expect(toMilliStrict("6,80")).toBeNull();
  });

  it("rejects drafts it cannot guarantee", () => {
    expect(toMilliStrict("12.3456")).toBeNull(); // >3 decimals
    expect(toMilliStrict("")).toBeNull();
    expect(toMilliStrict("abc")).toBeNull();
    expect(toMilliStrict("1.2.3")).toBeNull();
  });
});

describe("mulMilli (exact product)", () => {
  it("produces the sample invoices exactly", () => {
    // 2400 pcs × USD 6.80 = 16320.000
    expect(mulMilli(6800, 2400000)).toBe(16320000);
    // 180 pcs × EUR 42.50 = 7650.000
    expect(mulMilli(42500, 180000)).toBe(7650000);
  });

  it("rounds half away from zero at 3dp", () => {
    // 0.333 × 0.999 = 0.332667 → 0.333 (68% would stay; ≥667 bumps up)
    expect(mulMilli(333, 999)).toBe(333);
    // negative: -0.333×-0.999 → +0.333
    expect(mulMilli(-333, -999)).toBe(333);
  });

  it("handles units no-op products", () => {
    expect(mulMilli(1000, 1000)).toBe(1000); // 1.000 × 1.000 = 1
    expect(mulMilli(0, 9999999)).toBe(0);
  });
});

describe("milliToDisplay", () => {
  it("prints compact colloquial forms", () => {
    expect(milliToDisplay(16320000)).toBe("16320");
    expect(milliToDisplay(6800)).toBe("6.8");
    expect(milliToDisplay(-3200)).toBe("-3.2");
    expect(milliToDisplay(3120000)).toBe("3120");
  });
});

describe("weightToleranceMilliKg (grams)", () => {
  const tol = { absoluteKg: 2, relativeRatio: 0.003 };
  it("SHP-24811: max(2000 g, 0.003×3,120 kg) = 9,360 g — 45 kg gap must exceed it", () => {
    expect(weightToleranceMilliKg([3120000, 3165000], tol)).toBe(9360);
  });
  it("small shipments: absolute floor wins", () => {
    expect(weightToleranceMilliKg([500000, 501000], tol)).toBe(2000); // 500 vs 501 kg → Δ1,000 g ≤ 2,000 g PASS
  });
  it("needs ≥2 weights", () => {
    expect(weightToleranceMilliKg([1000], tol)).toBeNull();
  });
});
