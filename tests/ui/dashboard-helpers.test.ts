/**
 * PURE — dashboard UI helpers (src/lib/dashboard.ts): the status→chip
 * mapping and the searchParams coercion. No DB, no React.
 */
import { describe, expect, it } from "vitest";
import {
  parseDashboardFilters,
  SHIPMENT_STATUSES,
  statusLabel,
  statusTone,
  statusToneClasses,
} from "@/lib/dashboard";

describe("status chip mappings", () => {
  it("every machine state has a tone and a human label", () => {
    for (const s of SHIPMENT_STATUSES) {
      expect(statusTone(s)).toBeTruthy();
      expect(statusLabel(s)).not.toBe(s); // label is humanized
    }
  });

  it("tones distinguish attention levels (review=amber, approved=emerald, draft=neutral)", () => {
    expect(statusTone("NEEDS_REVIEW")).toBe("amber");
    expect(statusTone("APPROVED")).toBe("emerald");
    expect(statusTone("DRAFT")).toBe("zinc");
    expect(statusTone("PROCESSING")).toBe("sky");
    expect(statusTone("READY_FOR_APPROVAL")).toBe("violet");
    expect(statusTone("EXPORTED")).toBe("teal");
  });

  it("unknown states degrade to neutral zinc and the raw value", () => {
    expect(statusTone("SOMETHING_NEW")).toBe("zinc");
    expect(statusLabel("SOMETHING_NEW")).toBe("SOMETHING_NEW");
  });

  it("tone classes are a closed, non-empty class string per state", () => {
    for (const s of SHIPMENT_STATUSES) {
      expect(statusToneClasses(s)).toMatch(/^border-.* bg-.* text-.*$/);
    }
  });
});

describe("parseDashboardFilters — dirty URLs show the unfiltered list, not errors", () => {
  it("valid inputs pass through (q trimmed)", () => {
    expect(parseDashboardFilters({ status: "DRAFT", q: "  SHP-24  ", page: "2" })).toEqual({
      status: "DRAFT",
      q: "SHP-24",
      page: 2,
    });
  });

  it("unknown/absent status and page collapse to defaults", () => {
    expect(parseDashboardFilters({ status: "HACKED", q: "x" })).toEqual({ status: undefined, q: "x", page: 1 });
    expect(parseDashboardFilters({})).toEqual({ status: undefined, q: undefined, page: 1 });
  });

  it("blank or over-long q is dropped (contract caps q at 80)", () => {
    expect(parseDashboardFilters({ q: "   " }).q).toBeUndefined();
    expect(parseDashboardFilters({ q: "x".repeat(81) }).q).toBeUndefined();
    expect(parseDashboardFilters({ q: "x".repeat(80) }).q).toHaveLength(80);
  });

  it("array-valued params (repeated ?key=) are rejected by taking only clean strings", () => {
    expect(parseDashboardFilters({ status: ["DRAFT", "APPROVED"] }).status).toBeUndefined();
  });

  it("page out of the contract's 1..10000 range falls back to 1", () => {
    expect(parseDashboardFilters({ page: "0" }).page).toBe(1);
    expect(parseDashboardFilters({ page: "10001" }).page).toBe(1);
    expect(parseDashboardFilters({ page: "abc" }).page).toBe(1);
  });
});
