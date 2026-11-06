/**
 * PURE — review-screen helpers (src/lib/review.ts): kind-aware value
 * formatting, confidence display, per-status machine permissions, and
 * check-detail rendering from REAL engine payload shapes. No DB, no React.
 */
import { describe, expect, it } from "vitest";
import {
  checkDetailRows,
  checkTitle,
  confidencePercent,
  fieldLabel,
  fieldStatusLabel,
  formatFieldValue,
  isLowConfidence,
  rawEditableValue,
  reviewPermissions,
  toReviewField,
} from "@/lib/review";

const f = (over: Partial<Parameters<typeof formatFieldValue>[0]>) => ({
  kind: "TEXT" as const,
  text: null,
  numeric: null,
  date: null,
  currency: null,
  isUnreadable: false,
  ...over,
});

describe("formatFieldValue (kind-aware, honest degenerate cases)", () => {
  it("formats money with the field's own currency", () => {
    expect(formatFieldValue(f({ kind: "MONEY", numeric: "7650", currency: "EUR" }))).toMatch(/7,650\.00/);
    expect(formatFieldValue(f({ kind: "MONEY", numeric: "7650", currency: "USD" }))).toMatch(/7,650\.00/);
    expect(formatFieldValue(f({ kind: "MONEY", numeric: "7650", currency: null }))).toMatch(/7,650/); // no invented currency
  });

  it("formats weights with kg, counts/qty plain, dates as d MMM yyyy", () => {
    expect(formatFieldValue(f({ kind: "WEIGHT_KG", numeric: "3120" }))).toBe("3,120 kg");
    expect(formatFieldValue(f({ kind: "COUNT", numeric: "48" }))).toBe("48");
    expect(formatFieldValue(f({ kind: "DATE", date: "2024-03-14T00:00:00.000Z" }))).toBe("14 Mar 2024");
    expect(formatFieldValue(f({ text: "  Company B (China)  " }))).toBe("Company B (China)");
  });

  it("never fabricates: missing/unreadable/garbage renders dashes or Unreadable", () => {
    expect(formatFieldValue(f({ kind: "MONEY", numeric: null }))).toBe("—");
    expect(formatFieldValue(f({ kind: "DATE", date: null }))).toBe("—");
    expect(formatFieldValue(f({ kind: "WEIGHT_KG", numeric: "NaN" }))).toBe("—");
    expect(formatFieldValue(f({ kind: "TEXT", text: " " }))).toBe("—");
    expect(formatFieldValue(f({ kind: "TEXT", isUnreadable: true }))).toBe("Unreadable");
  });
});

describe("rawEditableValue (round-trips through the server's parseCorrection)", () => {
  it("money keeps 2dp, weights/counts bare, dates ISO yyyy-mm-dd", () => {
    expect(rawEditableValue(f({ kind: "MONEY", numeric: "7650" }))).toBe("7650.00");
    expect(rawEditableValue(f({ kind: "WEIGHT_KG", numeric: "3120.000" }))).toBe("3120");
    expect(rawEditableValue(f({ kind: "COUNT", numeric: "48.000" }))).toBe("48");
    expect(rawEditableValue(f({ kind: "DATE", date: "2024-03-14T00:00:00.000Z" }))).toBe("2024-03-14");
    expect(rawEditableValue(f({ text: "Company B" }))).toBe("Company B");
    expect(rawEditableValue(f({ kind: "MONEY", numeric: null }))).toBe("");
  });
});

describe("confidence display", () => {
  it("maps Decimal-as-string to a percent; manual entries have none", () => {
    expect(confidencePercent("0.930")).toBe("93%");
    expect(confidencePercent("0.99")).toBe("99%");
    expect(confidencePercent(null)).toBeNull();
    expect(confidencePercent("junk")).toBeNull();
  });

  it("low-confidence threshold is 0.90 (exclusive), the brief's 'uncertain'", () => {
    expect(isLowConfidence("0.899")).toBe(true);
    expect(isLowConfidence("0.9")).toBe(false);
    expect(isLowConfidence("0.99")).toBe(false);
    expect(isLowConfidence(null)).toBe(false);
  });
});

describe("field + status labels (the 19-key dictionary, no free text)", () => {
  it("labels known keys and renders unknown keys raw", () => {
    expect(fieldLabel("grossWeightKg")).toBe("Gross weight");
    expect(fieldLabel("totalValue")).toBe("Total value");
    expect(fieldLabel("mysteryKey")).toBe("mysteryKey");
  });

  it("distinguishes AI drafts from human writes — the brief's provenance rule", () => {
    expect(fieldStatusLabel("AI_DRAFT")).toBe("AI draft");
    expect(fieldStatusLabel("CORRECTED")).toBe("Corrected");
    expect(fieldStatusLabel("MANUAL_ENTERED")).toBe("Manually entered");
    expect(fieldStatusLabel("CONFIRMED")).toBe("Confirmed");
  });
});

describe("toReviewField normalization", () => {
  it("derives kind from the FIELD_KINDS dictionary; Decimals-as-strings pass through", () => {
    const rf = toReviewField({
      id: "f1",
      documentId: "d1",
      documentType: "INVOICE",
      fieldKey: "totalValue",
      valueText: null,
      valueNumeric: "7650.000",
      valueDate: null,
      currency: "EUR",
      confidence: "0.990",
      isUnreadable: false,
      status: "AI_DRAFT",
      sourcePage: 1,
      sourceExcerpt: "Total: EUR 7,650.00",
    });
    expect(rf.kind).toBe("MONEY");
    expect(rf.numeric).toBe("7650.000");
    expect(rf.confidence).toBe("0.990");
    expect(rf.sourcePage).toBe(1);
  });

  it("unknown fieldKeys degrade to TEXT (never crash the review screen)", () => {
    const rf = toReviewField({ id: "f2", documentId: "d1", documentType: "INVOICE", fieldKey: "mystery", status: "AI_DRAFT" });
    expect(rf.kind).toBe("TEXT");
    expect(formatFieldValue(rf)).toBe("—");
  });
});

describe("reviewPermissions (derived strictly from the machine's table)", () => {
  it("EXPORTED is read-only; DRAFT allows manual entry ONLY (it fires EXTRACTION_STARTED)", () => {
    expect(reviewPermissions("EXPORTED")).toEqual({
      canCorrect: false,
      canManualEntry: false,
      canResolve: false,
      readOnly: true,
    });
    expect(reviewPermissions("DRAFT")).toEqual({
      canCorrect: false, // HUMAN_WRITE not allowed in DRAFT → 409
      canManualEntry: true, // D-1b: DRAFT + entry → EXTRACTION_STARTED
      canResolve: false,
      readOnly: false,
    });
  });

  it("PROCESSING allows manual entry (extraction in progress) but not corrections", () => {
    expect(reviewPermissions("PROCESSING")).toEqual({
      canCorrect: false,
      canManualEntry: true,
      canResolve: true,
      readOnly: false,
    });
  });

  it("NEEDS_REVIEW/READY/APPROVED allow human writes; unknown statuses fail safe", () => {
    for (const s of ["NEEDS_REVIEW", "READY_FOR_APPROVAL", "APPROVED"]) {
      expect(reviewPermissions(s).canCorrect).toBe(true);
      expect(reviewPermissions(s).canManualEntry).toBe(true);
      expect(reviewPermissions(s).canResolve).toBe(true);
      expect(reviewPermissions(s).readOnly).toBe(false);
    }
    expect(reviewPermissions("SOMETHING_ELSE").readOnly).toBe(true);
  });
});

describe("checkDetailRows (renders the engine's REAL payload shapes)", () => {
  // The row-6 aggregate persists checkPayload's wrapper {details, failedRefs} —
  // exactly what the API serves the review screen.
  const wrap = (payload: Record<string, unknown>) => ({ details: payload, failedRefs: [] });

  it("INVOICE_TOTAL: line sum vs total vs difference, money-formatted", () => {
    const rows = checkDetailRows("INVOICE_TOTAL", wrap({ sumMilli: 7650000, totalMilli: 7650000, diffMilli: 0 }), "EUR");
    expect(rows.map((r) => r.label)).toEqual(["Line sum", "Invoice total", "Difference"]);
    expect(rows[0].value).toMatch(/7,650\.00/);
  });

  it("GROSS_WEIGHT_CONSISTENCY: per-document weights, difference, tolerance", () => {
    const rows = checkDetailRows("GROSS_WEIGHT_CONSISTENCY", wrap({
      weights: [
        { docType: "INVOICE", grams: 3120000 },
        { docType: "PACKING_LIST", grams: 3165000 },
        { docType: "BILL_OF_LADING", grams: 3165000 },
      ],
      diffGrams: 45000,
      toleranceGrams: 9360,
    }));
    expect(rows).toEqual([
      { label: "Weight · invoice", value: "3,120 kg" },
      { label: "Weight · packing list", value: "3,165 kg" },
      { label: "Weight · bill of lading", value: "3,165 kg" },
      { label: "Difference", value: "45 kg" },
      { label: "Tolerance", value: "9.36 kg" },
    ]);
  });

  it("PACKAGES_MATCH and CONTAINER_CONSISTENCY render their own payloads", () => {
    expect(checkDetailRows("PACKAGES_MATCH", wrap({ packingList: 12, bol: 10, diff: 2 }))).toEqual([
      { label: "Packing list", value: "12" },
      { label: "Bill of lading", value: "10" },
      { label: "Difference", value: "2" },
    ]);
    const cc = checkDetailRows("CONTAINER_CONSISTENCY", wrap({ bol: "MSLU7654321", packingList: null, iso6346Ok: true, mismatch: false }));
    expect(cc).toEqual([
      { label: "Bill of lading", value: "MSLU7654321" },
      { label: "Packing list", value: "not provided" },
      { label: "ISO 6346 form", value: "yes" },
      { label: "Cross-document match", value: "match" },
    ]);
  });

  it("REQUIRED_FIELDS lists what is missing; rules without details render none", () => {
    expect(checkDetailRows("REQUIRED_FIELDS", wrap({ missing: ["PACKING_LIST.grossWeightKg", "INVOICE.lineItems"] }))).toEqual([
      { label: "Missing inputs", value: "PACKING_LIST.grossWeightKg; INVOICE.lineItems" },
    ]);
    expect(checkDetailRows("QUANTITY_MATCH", undefined)).toEqual([]);
    expect(checkDetailRows("LINE_ARITHMETIC", null)).toEqual([]);
  });

  it("also accepts a raw engine result payload (unwrapped)", () => {
    expect(checkDetailRows("PACKAGES_MATCH", { packingList: 12, bol: 10, diff: 2 })[2].value).toBe("2");
  });

  it("unknown-but-real payloads render generically (nothing invented, nothing hidden)", () => {
    expect(checkDetailRows("FUTURE_RULE", wrap({ alpha: 1, beta: "x", nested: { a: 1 } }))).toEqual([
      { label: "alpha", value: "1" },
      { label: "beta", value: "x" },
    ]);
  });
});

describe("titles + status labels", () => {
  it("human titles for all nine rules; unknown renders raw", () => {
    expect(checkTitle("GROSS_WEIGHT_CONSISTENCY")).toBe("Gross weights across documents");
    expect(checkTitle("INVOICE_TOTAL")).toBe("Invoice total vs line sum");
    expect(checkTitle("FUTURE_RULE")).toBe("FUTURE_RULE");
    expect(fieldStatusLabel("WEIRD")).toBe("WEIRD");
  });
});
