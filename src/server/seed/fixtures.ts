/**
 * Synthetic demo dataset — the ONLY payload the seed writes (ADR-09).
 *
 * Values mirror the brief's sample shipments, already encoded and graded as engine
 * unit tests (tests/engines/crosschecks.test.ts):
 *  - SHP-24811: LED panels; invoice says 3,120 kg, packing list & BOL say 3,165 kg
 *    → the planted 45 kg discrepancy MUST FAIL CV-6 (one blocking fail).
 *  - SHP-24812: steel valves; 180 × EUR 42.50 = 7,650.00 exactly → zero blocking
 *    fails (the Ready-for-approval story).
 *
 * All numeric specs are ENGINE MILLI integers (×1000) — the single source of truth.
 * The DB layer converts to real-precision decimals at write time (run.ts), so the
 * engine consumes the exact values that seeded the database, with no second copy
 * of the numbers to drift.
 *
 * This module is PURE DATA + snapshot building: no prisma, no better-auth, no I/O.
 */
import { emptySnapshot, type DocSnapshot, type DocType, type FieldKey, type TypedFieldValue } from "../../lib/types";

export type SeedRole = "EXECUTIVE" | "MANAGER";

export interface DemoUserSpec {
  email: string;
  name: string;
  role: SeedRole;
}

/** Demo facility accounts (roles are server-assigned post-signup, run.ts). */
export const DEMO_USERS: DemoUserSpec[] = [
  { email: "exec@demo.cargolens.in", name: "Executive Demo", role: "EXECUTIVE" },
  { email: "manager@demo.cargolens.in", name: "Manager Demo", role: "MANAGER" },
];

export const DEMO_SUPPLIERS: { name: string; country: string }[] = [
  { name: "Company B (China)", country: "CN" },
  { name: "Company C (Sweden)", country: "SE" },
];

export interface DemoLineSpec {
  seq: number;
  description: string;
  hsnCode?: string;
  unit?: string;
  qtyMilli: number;
  unitPriceMilli: number;
  currency: string;
}

export interface DemoDocSpec {
  type: DocType;
  fields: Partial<Record<FieldKey, TypedFieldValue>>;
  lineItems: DemoLineSpec[];
}

export interface DemoShipmentSpec {
  ref: string;
  supplierName: string;
  docs: DemoDocSpec[];
  /** What the engine must conclude from this data (re-asserted by tests). */
  expectedBlockingFails: number;
}

/** Typed-value builder — same semantics as the engine tests' helper. */
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

/**
 * Display-realistic synthetic confidence values (0..1): the demo must SHOW the
 * confidence feature, deterministically (same field → same confidence).
 */
export const FIELD_CONFIDENCE: Partial<Record<FieldKey, number>> = {
  supplierName: 0.93,
  supplierAddress: 0.88,
  supplierCountry: 0.97,
  consigneeName: 0.9,
  consigneeAddress: 0.87,
  invoiceNumber: 0.99,
  invoiceDate: 0.98,
  currency: 0.99,
  incoterm: 0.96,
  totalValue: 0.99,
  packagesCount: 0.9,
  packageType: 0.85,
  grossWeightKg: 0.98,
  netWeightKg: 0.97,
  containerNumber: 0.86,
  bolNumber: 0.99,
  vesselName: 0.95,
  portOfLoading: 0.96,
  portOfDischarge: 0.96,
};

const CONTAINER_24811 = "MSLU7654321";

/** SHP-24811 — the brief's planted discrepancy (Δ45 kg on 3,120 kg ⇒ CV-6 FAIL). */
const SHP_24811: DemoShipmentSpec = {
  ref: "SHP-24811",
  supplierName: "Company B (China)",
  expectedBlockingFails: 1,
  docs: [
    {
      type: "INVOICE",
      fields: {
        supplierName: f("TEXT", "Company B (China)"),
        supplierCountry: f("TEXT", "CN"),
        consigneeName: f("TEXT", "Company A (India)"),
        invoiceNumber: f("TEXT", "INV-CB-8841"),
        invoiceDate: f("DATE", "2024-03-12"),
        currency: f("TEXT", "USD"),
        incoterm: f("TEXT", "FOB"),
        totalValue: f("MONEY", 16_320_000, "USD"),
        grossWeightKg: f("WEIGHT_KG", 3_120_000),
        containerNumber: f("TEXT", CONTAINER_24811),
      },
      lineItems: [{ seq: 1, description: "LED panel light 40W", hsnCode: "9405", unit: "pcs", qtyMilli: 2_400_000, unitPriceMilli: 6_800, currency: "USD" }],
    },
    {
      type: "PACKING_LIST",
      fields: {
        packagesCount: f("COUNT", 40),
        grossWeightKg: f("WEIGHT_KG", 3_165_000),
        netWeightKg: f("WEIGHT_KG", 2_848_500),
        containerNumber: f("TEXT", CONTAINER_24811),
      },
      lineItems: [{ seq: 1, description: "LED panel light 40W", hsnCode: "9405", unit: "pcs", qtyMilli: 2_400_000, unitPriceMilli: 6_800, currency: "USD" }],
    },
    {
      type: "BILL_OF_LADING",
      fields: {
        bolNumber: f("TEXT", "MSCU8810024"),
        packagesCount: f("COUNT", 40),
        grossWeightKg: f("WEIGHT_KG", 3_165_000),
        containerNumber: f("TEXT", CONTAINER_24811),
        portOfLoading: f("TEXT", "CNNSA"),
        portOfDischarge: f("TEXT", "INNSA1"),
        vesselName: f("TEXT", "MSC Maria"),
      },
      lineItems: [],
    },
  ],
};

/** SHP-24812 — the brief's clean-arithmetic shipment (180 × 42.50 = 7,650.00 ⇒ PASS). */
const SHP_24812: DemoShipmentSpec = {
  ref: "SHP-24812",
  supplierName: "Company C (Sweden)",
  expectedBlockingFails: 0,
  docs: [
    {
      type: "INVOICE",
      fields: {
        supplierName: f("TEXT", "Company C (Sweden)"),
        supplierCountry: f("TEXT", "SE"),
        consigneeName: f("TEXT", "Company A (India)"),
        invoiceNumber: f("TEXT", "INV-CC-1011"),
        invoiceDate: f("DATE", "2024-03-14"),
        currency: f("TEXT", "EUR"),
        incoterm: f("TEXT", "CIF"),
        totalValue: f("MONEY", 7_650_000, "EUR"),
        grossWeightKg: f("WEIGHT_KG", 1_460_000),
        containerNumber: f("TEXT", "MSCU7654321"),
      },
      lineItems: [{ seq: 1, description: "Steel ball valve DN50", hsnCode: "8481", unit: "pcs", qtyMilli: 180_000, unitPriceMilli: 42_500, currency: "EUR" }],
    },
    {
      type: "PACKING_LIST",
      fields: {
        packagesCount: f("COUNT", 6),
        grossWeightKg: f("WEIGHT_KG", 1_460_000),
        netWeightKg: f("WEIGHT_KG", 1_314_000),
        containerNumber: f("TEXT", "MSCU7654321"),
      },
      lineItems: [{ seq: 1, description: "Steel ball valve DN50", hsnCode: "8481", unit: "pcs", qtyMilli: 180_000, unitPriceMilli: 42_500, currency: "EUR" }],
    },
    {
      type: "BILL_OF_LADING",
      fields: {
        bolNumber: f("TEXT", "MSCU9930011"),
        packagesCount: f("COUNT", 6),
        grossWeightKg: f("WEIGHT_KG", 1_460_000),
        containerNumber: f("TEXT", "MSCU7654321"),
        portOfLoading: f("TEXT", "SESTO"),
        portOfDischarge: f("TEXT", "INNSA1"),
        vesselName: f("TEXT", "MSC Baltic"),
      },
      lineItems: [],
    },
  ],
};

export const DEMO_SHIPMENTS: DemoShipmentSpec[] = [SHP_24811, SHP_24812];

/** Engine-ready snapshots — the same values, in the shape runChecks consumes. */
export function buildSnapshots(spec: DemoShipmentSpec): Record<DocType, DocSnapshot> {
  const out: Record<DocType, DocSnapshot> = {
    INVOICE: emptySnapshot(),
    PACKING_LIST: emptySnapshot(),
    BILL_OF_LADING: emptySnapshot(),
  };
  for (const d of spec.docs) {
    out[d.type] = {
      uploaded: true,
      readable: true,
      fields: d.fields,
      lineItems: d.lineItems.map((l) => ({
        seq: l.seq,
        description: l.description,
        hsnCode: l.hsnCode,
        unit: l.unit,
        quantity: l.qtyMilli,
        unitPrice: { minor: l.unitPriceMilli, currency: l.currency },
        lineTotal: { minor: Number((BigInt(l.qtyMilli) * BigInt(l.unitPriceMilli)) / 1000n), currency: l.currency },
      })),
    };
  }
  return out;
}
