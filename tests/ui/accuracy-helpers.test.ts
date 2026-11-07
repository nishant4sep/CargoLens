/**
 * PURE — accuracy-report helpers (src/lib/accuracy.ts): deterministic,
 * traceable derivations over row-19/row-4 responses. The anti-fabrication
 * rules are tested AS rules: empty denominators yield null (never 0%),
 * missing confidence stays null, and verified accuracy is UNAVAILABLE in
 * this build — no ground truth, so no percentage may exist.
 */
import { describe, expect, it } from "vitest";
import {
  confidenceDisplay,
  fieldReportRows,
  ratePercent,
  supplierReportRows,
  verifiedAccuracy,
  workloadSummary,
  type AccuracyFieldRow,
  type AccuracySupplierRow,
} from "@/lib/accuracy";

describe("ratePercent (exact, honest about empty denominators)", () => {
  it("computes exact one-decimal percentages", () => {
    expect(ratePercent(0, 4)).toBe("0.0%"); // a real zero with data is a real zero
    expect(ratePercent(1, 4)).toBe("25.0%");
    expect(ratePercent(1, 3)).toBe("33.3%");
    expect(ratePercent(2, 3)).toBe("66.7%");
    expect(ratePercent(7, 7)).toBe("100.0%");
  });

  it("NEVER fabricates: zero denominator / garbage → null (the empty state)", () => {
    expect(ratePercent(0, 0)).toBeNull();
    expect(ratePercent(3, 0)).toBeNull();
    expect(ratePercent(NaN, 5)).toBeNull();
    expect(ratePercent(1, -2)).toBeNull();
  });
});

describe("confidenceDisplay (Decimal-as-string → percent)", () => {
  it("maps valid averages; missing or malformed stays null", () => {
    expect(confidenceDisplay("0.930")).toBe("93%");
    expect(confidenceDisplay("0")).toBe("0%"); // a real average of zero-confidence rows
    expect(confidenceDisplay(null)).toBeNull();
    expect(confidenceDisplay("junk")).toBeNull();
    expect(confidenceDisplay("1.5")).toBeNull(); // outside [0,1] — cannot be a confidence
  });
});

describe("fieldReportRows (per-field correction rate + provenance counts)", () => {
  it("maps the row-19 shape with labels and rates; unknown keys render raw", () => {
    const rows: AccuracyFieldRow[] = [
      { fieldKey: "totalValue", total: 4, aiDraft: 0, confirmed: 4, corrected: 1, manualEntered: 3, avgConfidence: null },
      { fieldKey: "mysteryKey", total: 2, aiDraft: 2, confirmed: 0, corrected: 0, manualEntered: 0, avgConfidence: "0.950" },
    ];
    const mapped = fieldReportRows(rows);
    expect(mapped[0].field).toBe("Total value"); // the 19-key dictionary
    expect(mapped[0].correctionRate).toBe("25.0%");
    expect(mapped[0].avgConfidence).toBeNull(); // manual entries have no confidence
    expect(mapped[1].field).toBe("mysteryKey"); // unknown → raw, honest
    expect(mapped[1].correctionRate).toBe("0.0%");
    expect(mapped[1].avgConfidence).toBe("95%");
  });

  it("an empty field row renders '— no data', never a fabricated 0%", () => {
    const mapped = fieldReportRows([{ fieldKey: "currency", total: 0, aiDraft: 0, confirmed: 0, corrected: 0, manualEntered: 0, avgConfidence: null }]);
    expect(mapped[0].correctionRate).toBeNull();
  });
});

describe("supplierReportRows (per-supplier readiness)", () => {
  it('maps the row-19 supplier shape; the null bucket renders "No supplier"', () => {
    const rows: AccuracySupplierRow[] = [
      { supplierId: "s1", supplierName: "Company C (Sweden)", shipments: 2, fieldsTotal: 42, fieldsCleared: 40, avgConfidence: null },
      { supplierId: null, supplierName: null, shipments: 1, fieldsTotal: 0, fieldsCleared: 0, avgConfidence: null },
    ];
    const mapped = supplierReportRows(rows);
    expect(mapped[0].supplier).toBe("Company C (Sweden)");
    expect(mapped[0].clearedShare).toBe("95.2%");
    expect(mapped[1].supplier).toBe("No supplier");
    expect(mapped[1].clearedShare).toBeNull(); // zero fields — empty state, not 0%
  });
});

describe("workloadSummary (row-4 aggregate → histogram + open discrepancies)", () => {
  it("empty list → zero totals, empty histogram buckets still present", () => {
    const w = workloadSummary([]);
    expect(w.total).toBe(0);
    expect(w.byStatus).toEqual({ DRAFT: 0, PROCESSING: 0, NEEDS_REVIEW: 0, READY_FOR_APPROVAL: 0, APPROVED: 0, EXPORTED: 0 });
    expect(w.openBlocking).toEqual([]);
    expect(w.truncated).toBe(false);
  });

  it("counts by status and extracts the open blocking work, sorted worst-first", () => {
    const w = workloadSummary([
      { ref: "SHP-2", status: "NEEDS_REVIEW", blockingFails: 2 },
      { ref: "SHP-1", status: "NEEDS_REVIEW", blockingFails: 1 },
      { ref: "SHP-3", status: "APPROVED", blockingFails: 0 },
      { ref: "SHP-4", status: "EXPORTED", blockingFails: 0 },
    ]);
    expect(w.total).toBe(4);
    expect(w.byStatus.NEEDS_REVIEW).toBe(2);
    expect(w.byStatus.APPROVED).toBe(1);
    expect(w.byStatus.DRAFT).toBe(0);
    expect(w.openBlocking).toEqual([
      { ref: "SHP-2", blockingFails: 2 },
      { ref: "SHP-1", blockingFails: 1 },
    ]);
  });

  it("propagates the truncation flag (honest lower bound)", () => {
    expect(workloadSummary([{ ref: "SHP-1", status: "DRAFT", blockingFails: 0 }], true).truncated).toBe(true);
  });
});

describe("verifiedAccuracy (the anti-fabrication tripwire)", () => {
  it("is UNAVAILABLE in this build — no ground truth, so NO percentage may exist", () => {
    const v = verifiedAccuracy();
    expect(v.available).toBe(false);
    expect(v.reason).toMatch(/no ground-truth/i);
    // The type-level guarantee: VerifiedAccuracyState has no number field to
    // fill with a fabricated value. When ground truth lands, this test is
    // the tripwire forcing the honest rewrite.
  });
});
