/**
 * Cross-check tolerances — the single file where numeric judgement lives (PRD FR-016).
 * Units are ENGINE units: milli (value × 1000) everywhere, exact integers.
 *  - money: 1 milli = 0.001 of the currency (USD 6.80 = 6800 milli)
 *  - weights: milli-kg == grams (3120 kg = 3,120,000)
 *  - counts are plain integers (not milli)
 */
export interface Tolerances {
  /** CV-3: |Σ lineTotals − invoice total| in milli. PASS ≤ pass, WARNING ≤ warn, FAIL beyond. */
  invoiceTotal: { passMilli: number; warnMilli: number };
  /** CV-2: per-line |qty × unitPrice − lineTotal| budget in milli. */
  lineArithmetic: { warnMilli: number };
  /** CV-4: quantity totals invoice↔packing list, milli. Exact in v1. */
  quantity: { passMilli: number };
  /** CV-5: package counts PL↔BOL, plain units. Exact in v1 (units are text-level only, A3). */
  packageCount: { passUnits: number };
  /** CV-6: gross weight Δ acceptable iff Δ ≤ max(absoluteGrams, relativeRatio × min weight). */
  weightKg: { absoluteGrams: number; relativeRatio: number };
}

export const DEFAULT_TOLERANCES: Tolerances = {
  // Rationale: line-level rounding of 2-dp unit prices can cumulate ~1–2 cents on a
  // 2,400-qty invoice (SHP-24811: 2400 × 6.80). Anything beyond 0.50 (≈ a "would-be
  // rounding" of a displayed total) indicates a real discrepancy, not rounding noise.
  invoiceTotal: { passMilli: 20, warnMilli: 500 },
  lineArithmetic: { warnMilli: 20 },
  quantity: { passMilli: 0 },
  packageCount: { passUnits: 0 },
  // Weights: 2 kg covers scale/rounding noise; 0.3% covers differing scale metadata
  // across documents. SHP-24811 sanity: min 3,120 kg → tol = max(2000 g, 9,360 g) =
  // 9,360 g; the planted 45,000 g (45 kg) gap FAILS; a 3 kg noise case PASSES.
  weightKg: { absoluteGrams: 2000, relativeRatio: 0.003 },
} as const;
