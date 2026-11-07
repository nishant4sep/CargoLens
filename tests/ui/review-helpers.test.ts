/**
 * PURE — review-screen helpers (src/lib/review.ts): kind-aware value
 * formatting, confidence display, per-status machine permissions, and
 * check-detail rendering from REAL engine payload shapes. No DB, no React.
 */
import { describe, expect, it } from "vitest";
import {
  approvalReadiness,
  auditSummary,
  canApprove,
  canExport,
  checkDetailRows,
  checkTitle,
  confidencePercent,
  extractAction,
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

/* ------------------------- P4.5: approval + export ------------------------ */

describe("canApprove / canExport (derived from the machine's own table)", () => {
  it("APPROVE exists only from READY_FOR_APPROVAL, and only for a MANAGER", () => {
    expect(canApprove("READY_FOR_APPROVAL", "MANAGER")).toBe(true);
    expect(canApprove("READY_FOR_APPROVAL", "EXECUTIVE")).toBe(false); // row 14: 403
    expect(canApprove("NEEDS_REVIEW", "MANAGER")).toBe(false); // machine: NOT_READY_FOR_APPROVAL
    expect(canApprove("APPROVED", "MANAGER")).toBe(false);
    expect(canApprove("EXPORTED", "MANAGER")).toBe(false);
    expect(canApprove("DRAFT", "MANAGER")).toBe(false);
  });

  it("EXPORT exists only from APPROVED — and deliberately takes NO role (row 16 contract)", () => {
    expect(canExport("APPROVED")).toBe(true);
    expect(canExport("READY_FOR_APPROVAL")).toBe(false); // machine: PREMATURE_EXPORT
    expect(canExport("EXPORTED")).toBe(false); // terminal — no re-export
    expect(canExport("NEEDS_REVIEW")).toBe(false);
    expect(canExport("DRAFT")).toBe(false);
  });
});

describe("approvalReadiness (human summary over the aggregate + engine seam)", () => {
  const base = {
    documents: [{ type: "INVOICE" }, { type: "PACKING_LIST" }, { type: "BILL_OF_LADING" }],
    fields: [] as Array<{ documentType: string; fieldKey: string; status: string }>,
    checks: [] as Array<{ ruleKey: string; result: string; severity: string; resolvedAt: string | null }>,
  };

  it("counts every required key of a missing document as outstanding, and names the doc", () => {
    const r = approvalReadiness({ ...base, documents: [{ type: "INVOICE" }] });
    expect(r.missingDocs).toEqual(["PACKING_LIST", "BILL_OF_LADING"]);
    // INVOICE rows absent too (7 keys) + PACKING_LIST 2 + BOL 5 — all outstanding
    expect(r.outstanding).toHaveLength(14);
    expect(r.outstanding.filter((o) => o.docType === "PACKING_LIST").map((o) => o.fieldKey)).toEqual([
      "packagesCount",
      "grossWeightKg",
    ]);
  });

  it("an AI_DRAFT row is outstanding; CONFIRMED/CORRECTED/MANUAL_ENTERED are cleared", () => {
    const r = approvalReadiness({
      ...base,
      fields: [
        { documentType: "PACKING_LIST", fieldKey: "packagesCount", status: "AI_DRAFT" },
        { documentType: "PACKING_LIST", fieldKey: "grossWeightKg", status: "MANUAL_ENTERED" },
      ],
    });
    // PACKING_LIST: AI_DRAFT outstanding, MANUAL_ENTERED cleared; the other two
    // documents have no rows at all → their keys are outstanding too.
    expect(r.outstanding.filter((o) => o.docType === "PACKING_LIST")).toEqual([{ docType: "PACKING_LIST", fieldKey: "packagesCount" }]);
    expect(r.outstanding).toHaveLength(13);
  });

  it("blocking list mirrors the gate's criteria (FAIL + BLOCKING + unresolved); corrections/resolutions counted", () => {
    const r = approvalReadiness({
      ...base,
      fields: [{ documentType: "INVOICE", fieldKey: "totalValue", status: "CORRECTED" }],
      checks: [
        { ruleKey: "GROSS_WEIGHT_CONSISTENCY", result: "FAIL", severity: "BLOCKING", resolvedAt: null },
        { ruleKey: "INVOICE_TOTAL", result: "FAIL", severity: "BLOCKING", resolvedAt: "2026-11-06T10:00:00.000Z" }, // accepted with note
        { ruleKey: "LINE_ARITHMETIC", result: "WARNING", severity: "WARNING", resolvedAt: null }, // not blocking
        { ruleKey: "CURRENCY_CONSISTENCY", result: "PASS", severity: "BLOCKING", resolvedAt: null },
      ],
    });
    expect(r.blocking).toEqual(["GROSS_WEIGHT_CONSISTENCY"]);
    expect(r.corrections).toBe(1);
    expect(r.resolutions).toBe(1);
  });
});

describe("auditSummary (renders ONLY real payload keys — all 13 actions verified)", () => {
  it("FIELD_CORRECTED → label + from → to; FIELD_CONFIRMED → label", () => {
    expect(
      auditSummary("FIELD_CORRECTED", { fieldKey: "totalValue", fieldId: "f1", from: "5100", to: "5000.00" }),
    ).toBe("Total value: 5100 → 5000.00");
    expect(auditSummary("FIELD_CONFIRMED", { fieldKey: "invoiceNumber", fieldId: "f1" })).toBe("Invoice number");
  });

  it("DISCREPANCY_RESOLVED → check title + note VERBATIM", () => {
    expect(
      auditSummary("DISCREPANCY_RESOLVED", {
        ruleKey: "GROSS_WEIGHT_CONSISTENCY",
        note: "Supplier scale certificate matches the packing list; the invoice weight is stale.",
      }),
    ).toBe('Gross weights across documents — “Supplier scale certificate matches the packing list; the invoice weight is stale.”');
  });

  it("CHECKS_RECOMPUTED → blockingFails + fieldsCleared (+ results length), never the payload dump", () => {
    expect(auditSummary("CHECKS_RECOMPUTED", { blockingFails: 2, fieldsCleared: true, results: [{}, {}, {}, {}, {}, {}, {}, {}, {}] })).toBe(
      "blockingFails: 2 · fieldsCleared: true · 9 checks",
    );
    expect(auditSummary("CHECKS_RECOMPUTED", { blockingFails: 0, fieldsCleared: true })).toBe("blockingFails: 0 · fieldsCleared: true");
  });

  it("EXPORT_GENERATED → file + truncated sha + bytes; EXPORT_DOWNLOADED → file; APPROVAL_GRANTED → ref", () => {
    const sha = "3b1f" + "a".repeat(60);
    expect(auditSummary("EXPORT_GENERATED", { exportId: "e1", fileName: "SHP-1-cargolens-csv-v1.csv", csvSha256: sha, bytes: 1234 })).toBe(
      "SHP-1-cargolens-csv-v1.csv · sha 3b1faaaaaaaa… · 1.2 KB",
    );
    expect(auditSummary("EXPORT_DOWNLOADED", { exportId: "e1", fileName: "SHP-1-cargolens-csv-v1.csv" })).toBe("SHP-1-cargolens-csv-v1.csv");
    expect(auditSummary("APPROVAL_GRANTED", { ref: "SHP-202611-03" })).toBe("SHP-202611-03");
  });

  it("APPROVAL_REVOKED renders the machine's raw reason — no interpretation", () => {
    expect(auditSummary("APPROVAL_REVOKED", { reason: "HUMAN_WRITE" })).toBe("reason: HUMAN_WRITE");
    expect(auditSummary("APPROVAL_REVOKED", { reason: "MANUAL" })).toBe("reason: MANUAL");
  });

  it("upload/entry/lifecycle events render from their real keys only", () => {
    expect(auditSummary("SHIPMENT_CREATED", { ref: "SHP-1", source: "MANUAL", supplierId: "s1" })).toBe("SHP-1 · via MANUAL");
    expect(auditSummary("DOCUMENT_UPLOADED", { documentId: "d1", type: "INVOICE", sha256Hex: "abcd" + "0".repeat(60), sizeBytes: 44 })).toContain(
      "Invoice · 44 B · sha abcd00000000",
    );
    expect(auditSummary("EXTRACTION_STARTED", { via: "MANUAL_ENTRY", documentId: "d1" })).toBe("via MANUAL_ENTRY");
    expect(auditSummary("DOCS_REACHED_TERMINAL", { via: "MANUAL_ENTRY", documents: 3 })).toBe("via MANUAL_ENTRY · 3 documents");
    expect(auditSummary("MANUAL_ENTRY", { documentId: "d1", fieldKeys: ["a", "b", "c"], lineItems: 1, docStatus: "PROCESSED" })).toBe(
      "PROCESSED · 3 fields · 1 line item",
    );
  });

  it("unknown actions + degenerate payloads degrade honestly", () => {
    expect(auditSummary("FUTURE_EVENT", { alpha: 1, nested: { a: 1 } })).toBe("alpha: 1");
    expect(auditSummary("FIELD_CORRECTED", null)).toBeNull();
    expect(auditSummary("FIELD_CORRECTED", "junk")).toBeNull();
    expect(auditSummary("FIELD_CORRECTED", { fieldKey: "unknownKey", from: "1", to: "2" })).toBe("unknownKey: 1 → 2");
  });
});

describe("extractAction (Phase 5 button eligibility, derived from row-9 + machine rules)", () => {
  it("UPLOADED and FAILED documents extract; FAILED is retryable by design", () => {
    expect(extractAction("DRAFT", "UPLOADED")).toBe("extract");
    expect(extractAction("PROCESSING", "UPLOADED")).toBe("extract");
    expect(extractAction("NEEDS_REVIEW", "FAILED")).toBe("extract");
  });

  it("PROCESSED and UNREADABLE offer RE-extraction (the AI layer is replaceable)", () => {
    expect(extractAction("NEEDS_REVIEW", "PROCESSED")).toBe("re-extract");
    expect(extractAction("READY_FOR_APPROVAL", "UNREADABLE")).toBe("re-extract");
  });

  it("a PROCESSING document hides the action - a run is in flight and the service 409s", () => {
    expect(extractAction("PROCESSING", "PROCESSING")).toBeNull();
  });

  it("APPROVED and EXPORTED hide the action (no side-effect revocation, no terminal writes)", () => {
    expect(extractAction("APPROVED", "UPLOADED")).toBeNull();
    expect(extractAction("EXPORTED", "UPLOADED")).toBeNull();
    expect(extractAction("EXPORTED", "PROCESSED")).toBeNull();
  });
});