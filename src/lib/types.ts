/** Shared domain types for CargoLens engines and services.
 *  Kept framework-free and I/O-free so engines stay pure (ADR-01/03). */

export type DocType = "INVOICE" | "PACKING_LIST" | "BILL_OF_LADING";

export const DOC_TYPES: DocType[] = ["INVOICE", "PACKING_LIST", "BILL_OF_LADING"];

/** The AI field dictionary — single source of truth for extraction + validation + reports. */
export const FIELD_KEYS = [
  "supplierName",
  "supplierAddress",
  "supplierCountry",
  "consigneeName",
  "consigneeAddress",
  "invoiceNumber",
  "invoiceDate",
  "currency",
  "incoterm",
  "totalValue",
  "packagesCount",
  "packageType",
  "grossWeightKg",
  "netWeightKg",
  "containerNumber",
  "bolNumber",
  "vesselName",
  "portOfLoading",
  "portOfDischarge",
] as const;

export type FieldKey = (typeof FIELD_KEYS)[number];

export function isFieldKey(k: string): k is FieldKey {
  return (FIELD_KEYS as readonly string[]).includes(k);
}

/**
 * Typing of values: engines must never deal with raw strings for numeric logic (ADR-03).
 *
 * SCALE CONTRACT (important): every numeric `value` produced by the normalize layer is
 * an exact INTEGER at 3-decimal precision ("milli units"), defined per kind:
 *  - MONEY:  milli = 0.001 of the currency (USD 6.80 → 6800)
 *  - WEIGHT_KG: milli-kg == grams (3120 kg → 3120000)
 *  - QTY: milli (2400 pcs → 2400000)
 *  - COUNT: plain integer, NOT milli (48 cartons → 48)
 *  - DATE: ISO "yyyy-mm-dd" string; TEXT: canonical string.
 */
export type TypedFieldValue =
  | { kind: "TEXT"; value: string }
  | { kind: "DATE"; value: string } // ISO date "yyyy-mm-dd"
  | { kind: "MONEY"; value: number; currency: string | null } // integer milli units
  | { kind: "QTY"; value: number } // integer milli units
  | { kind: "WEIGHT_KG"; value: number } // integer grams (milli-kg)
  | { kind: "COUNT"; value: number }; // plain integer

export type FieldValueMap = Partial<Record<FieldKey, TypedFieldValue>>;

export interface LineItemSnapshot {
  seq: number;
  description: string;
  hsnCode?: string;
  quantity: number;
  unit?: string;
  unitPrice: { minor: number; currency: string | null } | null;
  lineTotal: { minor: number; currency: string | null } | null;
}

/** A document's full extraction snapshot as seen by deterministic engines. */
export interface DocSnapshot {
  uploaded: boolean;
  readable: boolean; // false = missing/unreadable/failed → treated as absent by checks
  fields: FieldValueMap;
  lineItems: LineItemSnapshot[];
}

export function emptySnapshot(): DocSnapshot {
  return { uploaded: false, readable: false, fields: {}, lineItems: [] };
}
