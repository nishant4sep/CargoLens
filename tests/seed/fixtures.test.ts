/**
 * Pure unit tests for the SEED FIXTURES — the fixture data is graded by the
 * same engine the product grades documents with. If these drift, the seed
 * integrity check in runSeed also throws, but this suite catches drift at
 * `npm test` time without any database.
 */
import { describe, expect, it } from "vitest";
import { runChecks, unresolvedBlockingCount } from "@/server/engines/crosschecks";
import {
  DEMO_SHIPMENTS,
  DEMO_SUPPLIERS,
  DEMO_USERS,
  buildSnapshots,
} from "@/server/seed/fixtures";

describe("seed fixtures — demo accounts and suppliers", () => {
  it("provides exactly two demo accounts with the two distinct roles", () => {
    expect(DEMO_USERS).toHaveLength(2);
    expect(DEMO_USERS.map((u) => u.email).sort()).toEqual([
      "exec@demo.cargolens.in",
      "manager@demo.cargolens.in",
    ]);
    expect(new Set(DEMO_USERS.map((u) => u.role))).toEqual(new Set(["EXECUTIVE", "MANAGER"]));
  });

  it("suppliers mirror the brief's two sample importers", () => {
    expect(DEMO_SUPPLIERS.map((s) => s.name).sort()).toEqual([
      "Company B (China)",
      "Company C (Sweden)",
    ]);
  });

  it("fixture dataset contains exactly the two brief shipments", () => {
    expect(DEMO_SHIPMENTS.map((s) => s.ref)).toEqual(["SHP-24811", "SHP-24812"]);
  });
});

describe("seed fixtures — SHP-24811 (LED panels, planted 45 kg mismatch)", () => {
  const spec = DEMO_SHIPMENTS.find((s) => s.ref === "SHP-24811")!;
  const results = runChecks(buildSnapshots(spec));

  it("CV-6 FAILs with Δ45,000 g and cites all three documents", () => {
    const cv6 = results.find((r) => r.ruleKey === "GROSS_WEIGHT_CONSISTENCY")!;
    expect(cv6.status).toBe("FAIL");
    expect(cv6.details?.diffGrams).toBe(45000);
    expect(
      new Set(cv6.failedRefs.map((x) => x.docType)),
    ).toEqual(new Set(["INVOICE", "PACKING_LIST", "BILL_OF_LADING"]));
  });

  it("is exactly ONE blocking fail — the demo's 'broken' shipment story", () => {
    expect(unresolvedBlockingCount(results)).toBe(1);
  });

  it("milli values match the brief: invoice 3,120,000 g vs PL/BOL 3,165,000 g", () => {
    const snaps = buildSnapshots(spec);
    expect(snaps.INVOICE.fields.grossWeightKg).toMatchObject({ kind: "WEIGHT_KG", value: 3_120_000 });
    expect(snaps.PACKING_LIST.fields.grossWeightKg).toMatchObject({ kind: "WEIGHT_KG", value: 3_165_000 });
    expect(snaps.BILL_OF_LADING.fields.grossWeightKg).toMatchObject({ kind: "WEIGHT_KG", value: 3_165_000 });
  });

  it("everything but weight stays arithmetic-clean", () => {
    expect(results.find((r) => r.ruleKey === "INVOICE_TOTAL")!.status).toBe("PASS");
    expect(results.find((r) => r.ruleKey === "LINE_ARITHMETIC")!.status).toBe("PASS");
    expect(results.find((r) => r.ruleKey === "QUANTITY_MATCH")!.status).toBe("PASS");
    expect(results.find((r) => r.ruleKey === "PACKAGES_MATCH")!.status).toBe("PASS");
  });
});

describe("seed fixtures — SHP-24812 (steel valves, clean arithmetic)", () => {
  const spec = DEMO_SHIPMENTS.find((s) => s.ref === "SHP-24812")!;
  const results = runChecks(buildSnapshots(spec));

  it("180 × 42.50 = 7,650.00 exactly: INVOICE_TOTAL passes", () => {
    expect(results.find((r) => r.ruleKey === "INVOICE_TOTAL")!.status).toBe("PASS");
  });

  it("zero blocking fails — the demo's 'ready' shipment story", () => {
    expect(unresolvedBlockingCount(results)).toBe(0);
  });
});

describe("seed fixtures — every spec agrees with the engine", () => {
  it.each(DEMO_SHIPMENTS.map((s) => [s.ref, s.expectedBlockingFails]))(
    "%s: declared expectedBlockingFails equals what the engine produces",
    (ref, expected) => {
      const spec = DEMO_SHIPMENTS.find((s) => s.ref === ref)!;
      expect(unresolvedBlockingCount(runChecks(buildSnapshots(spec)))).toBe(expected);
    },
  );
});
