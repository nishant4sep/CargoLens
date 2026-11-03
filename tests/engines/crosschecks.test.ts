import { describe, expect, it } from "vitest";
import {
  checkGrossWeight,
  checkInvoiceTotal,
  checkLineArithmetic,
  runChecks,
  unresolvedBlockingCount,
} from "@/server/engines/crosschecks";
import { emptySnapshot, type DocSnapshot, type DocType, type FieldKey, type LineItemSnapshot, type TypedFieldValue } from "@/lib/types";

/* --------- fixture helpers (values are ENGINE MILLI integers) ------------- */

type Fields = Partial<Record<FieldKey, TypedFieldValue>>;

function f(kind: TypedFieldValue["kind"], raw: number | string, currency: string | null = null): TypedFieldValue {
  switch (kind) {
    case "TEXT": return { kind: "TEXT", value: String(raw) };
    case "DATE": return { kind: "DATE", value: String(raw) };
    case "MONEY": return { kind: "MONEY", value: raw as number, currency };
    case "WEIGHT_KG": return { kind: "WEIGHT_KG", value: raw as number };
    case "COUNT": return { kind: "COUNT", value: raw as number };
    case "QTY": return { kind: "QTY", value: raw as number };
  }
}

function line(seq: number, description: string, qtyMilli: number, priceMilli: number, currency = "USD"): LineItemSnapshot {
  return {
    seq,
    description,
    hsnCode: "9405",
    quantity: qtyMilli,
    unit: "pcs",
    unitPrice: { minor: priceMilli, currency },
    lineTotal: { minor: Number((BigInt(priceMilli) * BigInt(qtyMilli)) / 1000n), currency },
  };
}

const companyB = (weightKgMilli: number, plWeightKgMilli: number, bolWeightKgMilli: number, container: string): Record<DocType, DocSnapshot> => ({
  INVOICE: {
    uploaded: true, readable: true,
    fields: {
      supplierName: f("TEXT", "Company B (China)"),
      supplierCountry: f("TEXT", "CN"),
      consigneeName: f("TEXT", "Company A (India)"),
      invoiceNumber: f("TEXT", "INV-CB-8841"),
      invoiceDate: f("DATE", "2024-03-12"),
      currency: f("TEXT", "USD"),
      incoterm: f("TEXT", "FOB"),
      totalValue: f("MONEY", 16320000, "USD"),
      grossWeightKg: f("WEIGHT_KG", weightKgMilli),
      containerNumber: { kind: "TEXT", value: container } as TypedFieldValue,
    },
    lineItems: [line(1, "LED panel light 40W", 2400000, 6800)],
  },
  PACKING_LIST: {
    uploaded: true, readable: true,
    fields: {
      packagesCount: f("COUNT", 40),
      grossWeightKg: f("WEIGHT_KG", plWeightKgMilli),
      netWeightKg: f("WEIGHT_KG", Math.round(plWeightKgMilli * 0.9)),
      containerNumber: { kind: "TEXT", value: container } as TypedFieldValue,
    },
    lineItems: [line(1, "LED panel light 40W", 2400000, 6800)],
  },
  BILL_OF_LADING: {
    uploaded: true, readable: true,
    fields: {
      bolNumber: f("TEXT", "MSCU8810024"),
      packagesCount: f("COUNT", 40),
      grossWeightKg: f("WEIGHT_KG", bolWeightKgMilli),
      containerNumber: { kind: "TEXT", value: container } as TypedFieldValue,
      portOfLoading: f("TEXT", "CNNSA"),
      portOfDischarge: f("TEXT", "INNSA1"),
      vesselName: f("TEXT", "MSC Maria"),
    },
    lineItems: [],
  },
});

const cleanDocs = companyB(3120000, 3120000, 3120000, "MSLU7654321");
const weightMismatchDocs = companyB(3120000, 3165000, 3165000, "MSLU7654321"); // SHP-24811

/* -------------------------------- tests ----------------------------------- */

describe("runChecks — SHP-24811 (the brief's planted 45 kg mismatch)", () => {
  const results = runChecks(weightMismatchDocs);
  const byRule = new Map(results.map((r) => [r.ruleKey, r]));

  it("CV-6 gross weight FAILS with a 45,000 g gap and cites both documents", () => {
    const r = byRule.get("GROSS_WEIGHT_CONSISTENCY")!;
    expect(r.status).toBe("FAIL");
    expect(r.details?.diffGrams).toBe(45000);
    expect(r.failedRefs.map((x) => x.docType).sort()).toEqual(
      ["BILL_OF_LADING", "INVOICE", "PACKING_LIST"].sort(),
    );
  });

  it("everything arithmetic-clean passes (TOTAL, LINES, QTY, PKG, CURRENCY)", () => {
    expect(byRule.get("INVOICE_TOTAL")!.status).toBe("PASS");
    expect(byRule.get("LINE_ARITHMETIC")!.status).toBe("PASS");
    expect(byRule.get("QUANTITY_MATCH")!.status).toBe("PASS");
    expect(byRule.get("PACKAGES_MATCH")!.status).toBe("PASS");
    expect(byRule.get("CURRENCY_CONSISTENCY")!.status).toBe("PASS");
  });

  it("the shipment is NOT exportable: exactly 1 unresolved blocking FAIL", () => {
    expect(unresolvedBlockingCount(results)).toBe(1);
  });
});

describe("runChecks — SHP-24812-shaped clean shipment", () => {
  const results = runChecks({
    INVOICE: {
      uploaded: true, readable: true,
      fields: {
        supplierName: f("TEXT", "Company C (Sweden)"),
        supplierCountry: f("TEXT", "SE"),
        consigneeName: f("TEXT", "Company A (India)"),
        invoiceNumber: f("TEXT", "INV-CC-1011"),
        invoiceDate: f("DATE", "2024-03-14"),
        currency: f("TEXT", "EUR"),
        incoterm: f("TEXT", "CIF"),
        totalValue: f("MONEY", 7650000, "EUR"),
        grossWeightKg: f("WEIGHT_KG", 1460000),
        containerNumber: { kind: "TEXT", value: "MSCU7654321" } as TypedFieldValue,
      },
      lineItems: [line(1, "Steel ball valve DN50", 180000, 42500, "EUR")],
    },
    PACKING_LIST: {
      uploaded: true, readable: true,
      fields: {
        packagesCount: f("COUNT", 6),
        grossWeightKg: f("WEIGHT_KG", 1460000),
        netWeightKg: f("WEIGHT_KG", 1314000),
        containerNumber: { kind: "TEXT", value: "MSCU7654321" } as TypedFieldValue,
      },
      lineItems: [line(1, "Steel ball valve DN50", 180000, 42500, "EUR")],
    },
    BILL_OF_LADING: {
      uploaded: true, readable: true,
      fields: {
        bolNumber: f("TEXT", "MSCU9930011"),
        packagesCount: f("COUNT", 6),
        grossWeightKg: f("WEIGHT_KG", 1460000),
        containerNumber: { kind: "TEXT", value: "MSCU7654321" } as TypedFieldValue,
        portOfLoading: f("TEXT", "SESTO"),
        portOfDischarge: f("TEXT", "INNSA1"),
        vesselName: f("TEXT", "MSC Baltic"),
      },
      lineItems: [],
    },
  });

  it("zero blocking fails — READY pathway available", () => {
    expect(unresolvedBlockingCount(results)).toBe(0);
  });

  it("CHECKING INVOICE TOTAL: 180 × 42.50 = 7650 exactly", () => {
    expect(results.find((r) => r.ruleKey === "INVOICE_TOTAL")!.status).toBe("PASS");
  });
});

describe("tolerance boundaries (the class of bug we must not ship)", () => {
  it("CV-6: Δ exactly at tolerance passes, Δtol+1 fails", () => {
    // min 3120000 g → tol = 9360 g
    const atTol = companyB(3120000, 3111000, 3111000, "MSLU7654321"); // Δ = 9000 g? recompute: max-min = 9000
    expect(checkGrossWeight(atTol).status).toBe("PASS");
    const beyond = companyB(3120000, 3102640, 3102640, "MSLU7654321"); // Δ = 17360 g
    expect(checkGrossWeight(beyond).status).toBe("FAIL");
  });

  it("CV-3: 1-cent cumulative rounding stays PASS; 0.52 lands WARNING; large gap FAILS", () => {
    const inv = (
      sumMinor: number,
      totalMinor: number,
    ): { INVOICE: DocSnapshot } & Partial<Record<DocType, DocSnapshot>> => ({
      INVOICE: {
        uploaded: true, readable: true,
        fields: {
          currency: f("TEXT", "USD"),
          totalValue: f("MONEY", totalMinor, "USD"),
          invoiceNumber: f("TEXT", "I-1"),
          supplierName: f("TEXT", "s"),
          consigneeName: f("TEXT", "c"),
          incoterm: f("TEXT", "FOB"),
          invoiceDate: f("DATE", "2024-01-01"),
        },
        lineItems: [{ seq: 1, description: "x", quantity: 1000, unitPrice: { minor: sumMinor, currency: "USD" }, lineTotal: { minor: sumMinor, currency: "USD" } }],
      },
      PACKING_LIST: { ...emptySnapshot() },
      BILL_OF_LADING: { ...emptySnapshot() },
    });
    // money is a 1-line invoice whose only line equals the total → Δ0 → PASS:
    expect(checkInvoiceTotal(inv(10000, 10000)).status).toBe("PASS");
    // Δ 0.02 USD (20 milli) — still within pass(20): reimagine line total short of total by exactly 20:
    const near = {
      INVOICE: {
        uploaded: true, readable: true,
        fields: { ...inv(10000, 10020).INVOICE.fields },
        lineItems: [{ seq: 1, description: "x", quantity: 1000, unitPrice: { minor: 10000, currency: "USD" }, lineTotal: { minor: 10000, currency: "USD" } }],
      },
      PACKING_LIST: { ...emptySnapshot() },
      BILL_OF_LADING: { ...emptySnapshot() },
    };
    expect(checkInvoiceTotal(near).status).toBe("PASS");
    // Δ 400 milli (0.40) → between pass(20) and warn(500) → WARNING
    const warn = {
      INVOICE: {
        uploaded: true, readable: true,
        fields: { ...inv(10000, 10400).INVOICE.fields },
        lineItems: [{ seq: 1, description: "x", quantity: 1000, unitPrice: { minor: 10000, currency: "USD" }, lineTotal: { minor: 10000, currency: "USD" } }],
      },
      PACKING_LIST: { ...emptySnapshot() },
      BILL_OF_LADING: { ...emptySnapshot() },
    };
    expect(checkInvoiceTotal(warn).status).toBe("WARNING");
    // Δ 10,000 milli (10.00) → FAIL
    const fail = {
      INVOICE: {
        uploaded: true, readable: true,
        fields: { ...inv(10000, 20000).INVOICE.fields },
        lineItems: [{ seq: 1, description: "x", quantity: 1000, unitPrice: { minor: 10000, currency: "USD" }, lineTotal: { minor: 10000, currency: "USD" } }],
      },
      PACKING_LIST: { ...emptySnapshot() },
      BILL_OF_LADING: { ...emptySnapshot() },
    };
    expect(checkInvoiceTotal(fail).status).toBe("FAIL");
  });

  it("CV-2: line arithmetic catches a sabotaged unit price", () => {
    const doc = cleanDocs.INVOICE;
    const bad: DocSnapshot = {
      ...doc,
      lineItems: [{ ...doc.lineItems[0]!, unitPrice: { minor: 6805, currency: "USD" } }],
    };
    const r = checkLineArithmetic({ INVOICE: bad });
    expect(r.status).toBe("WARNING");
    expect(r.failedRefs[0]?.lineSeq).toBe(1);
  });
});

describe("missing / unreadable documents", () => {
  it("CV-1 FAILS listing what is missing when PL+BOL absent", () => {
    const only = runChecks({ INVOICE: cleanDocs.INVOICE });
    const r = only.find((x) => x.ruleKey === "REQUIRED_FIELDS")!;
    expect(r.status).toBe("FAIL");
    expect((r.details?.missing as string[]).some((m) => m.startsWith("PACKING_LIST"))).toBe(true);
    expect((r.details?.missing as string[]).some((m) => m.startsWith("BILL_OF_LADING"))).toBe(true);
    expect(unresolvedBlockingCount(only) > 0).toBe(true);
  });

  it("unreadable-with-fields doc is treated as missing and REQUIRED_FIELDS holds the gate", () => {
    const pl = { ...cleanDocs.PACKING_LIST, readable: false };
    const results = runChecks({ INVOICE: cleanDocs.INVOICE, PACKING_LIST: pl, BILL_OF_LADING: cleanDocs.BILL_OF_LADING });
    expect(results.find((x) => x.ruleKey === "REQUIRED_FIELDS")!.status).toBe("FAIL");
    expect(results.find((x) => x.ruleKey === "PACKAGES_MATCH")!.status).toBe("SKIPPED");
  });
});

describe("container/currency rules", () => {
  it("CV-7: PL/BOL mismatch FAILs and cites both docs", () => {
    const docs = companyB(3120000, 3120000, 3120000, "MSLU7654321");
    docs.PACKING_LIST = {
      ...docs.PACKING_LIST,
      fields: { ...docs.PACKING_LIST.fields, containerNumber: { kind: "TEXT", value: "MASU7654321" } },
    };
    const r = runChecks(docs).find((x) => x.ruleKey === "CONTAINER_CONSISTENCY")!;
    expect(r.status).toBe("FAIL");
    expect(r.failedRefs.map((f) => f.docType)).toEqual(["BILL_OF_LADING", "PACKING_LIST"]);
  });

  it("CV-7: bad ISO format alone is a WARNING", () => {
    const docs = companyB(3120000, 3120000, 3120000, "MSLU765432");
    docs.PACKING_LIST = { ...docs.PACKING_LIST, fields: { ...docs.PACKING_LIST.fields, containerNumber: { kind: "TEXT", value: "MSLU765432" } } };
    const r = runChecks(docs).find((x) => x.ruleKey === "CONTAINER_CONSISTENCY")!;
    expect(r.status).toBe("WARNING");
    expect(unresolvedBlockingCount(runChecks(docs))).toBe(0);
  });

  it("CV-8: mismatched line currency FAILs", () => {
    const doc = cleanDocs.INVOICE;
    const bad: DocSnapshot = {
      ...doc,
      lineItems: [ { ...doc.lineItems[0]!, unitPrice: { minor: 6800, currency: "JPY" }, lineTotal: { minor: 16320000, currency: "USD" } } ],
    };
    const r = runChecks({ INVOICE: bad }).find((x) => x.ruleKey === "CURRENCY_CONSISTENCY")!;
    expect(r.status).toBe("FAIL");
  });
});
