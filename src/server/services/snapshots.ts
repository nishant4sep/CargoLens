/**
 * DB ↔ engine seam for the API layer: loads ExtractedField/LineItem rows into
 * the ENGINE's snapshot shape (the inverse of the seed's writer), and parses
 * human-typed correction strings into typed column values.
 *
 * The FIELD_KINDS dictionary (lib/types) is the single source of truth for the
 * kind of every fieldKey — the same dictionary the seed fixtures used.
 */
import { createHash } from "node:crypto";
import type { ExtractedField, Prisma } from "@prisma/client";
import { ApiError } from "@/server/http";
import {
  parseAmountToMilli,
  parseDateToIso,
  parseWeightToMilliKg,
} from "@/server/engines/normalize";
import {
  emptySnapshot,
  FIELD_KINDS,
  isFieldKey,
  type DocSnapshot,
  type DocType,
  type FieldKey,
  type TypedFieldValue,
} from "@/lib/types";

export type Db = Prisma.TransactionClient | PrismaClient;
import type { PrismaClient } from "@prisma/client";

const DOC_TYPES: DocType[] = ["INVOICE", "PACKING_LIST", "BILL_OF_LADING"];

function toNum(d: Prisma.Decimal | null): number | null {
  return d === null ? null : d.toNumber();
}

/** DB columns → typed engine value (inverse of the seed's typedValueToColumns). */
export function columnsToTyped(f: Pick<ExtractedField, "fieldKey" | "valueText" | "valueNumeric" | "valueDate" | "currency">): TypedFieldValue | null {
  const key = f.fieldKey as FieldKey;
  if (!isFieldKey(key)) return null;
  const kind = FIELD_KINDS[key];
  switch (kind) {
    case "TEXT":
      return { kind: "TEXT", value: f.valueText ?? "" };
    case "DATE":
      return { kind: "DATE", value: f.valueDate ? f.valueDate.toISOString().slice(0, 10) : "" };
    case "MONEY":
      return { kind: "MONEY", value: Math.round((toNum(f.valueNumeric) ?? 0) * 1000), currency: f.currency };
    case "COUNT":
      return { kind: "COUNT", value: Math.round(toNum(f.valueNumeric) ?? 0) };
    case "WEIGHT_KG":
      return { kind: "WEIGHT_KG", value: Math.round((toNum(f.valueNumeric) ?? 0) * 1000) };
    case "QTY":
      return { kind: "QTY", value: Math.round((toNum(f.valueNumeric) ?? 0) * 1000) };
  }
}

/** Loads a shipment's documents/fields/line items as engine snapshots. */
export async function loadSnapshots(db: Db, shipmentId: string): Promise<Record<DocType, DocSnapshot>> {
  const docs = await db.document.findMany({
    where: { shipmentId },
    include: { fields: true, lineItems: { orderBy: { seq: "asc" } } },
  });
  const out: Record<DocType, DocSnapshot> = {
    INVOICE: emptySnapshot(),
    PACKING_LIST: emptySnapshot(),
    BILL_OF_LADING: emptySnapshot(),
  };
  for (const d of docs) {
    const type = d.type as DocType;
    const snap = out[type];
    snap.uploaded = true;
    snap.readable = d.status === "PROCESSED"; // the effective-documents gate's input
    for (const f of d.fields) {
      const typed = columnsToTyped(f);
      if (typed && isFieldKey(f.fieldKey)) snap.fields[f.fieldKey] = typed;
    }
    snap.lineItems = d.lineItems.map((li) => ({
      seq: li.seq,
      description: li.description,
      hsnCode: li.hsnCode ?? undefined,
      unit: li.unit ?? undefined,
      // Engine unit is MILLI for line-item quantity (mulMilli: price×qty/1000;
      // buildSnapshots feeds qtyMilli) — the DB column is REAL units, so ×1000.
      // Serving real units here made LINE_ARITHMETIC false-WARN on perfect data
      // (found by the P4.4 review-workflow suite; the seed never recomputed
      // from DB rows, so the two paths never met before).
      quantity: Math.round(li.quantity.toNumber() * 1000),
      unitPrice: li.unitPrice === null ? null : { minor: Math.round(li.unitPrice.toNumber() * 1000), currency: null },
      lineTotal: li.lineTotal === null ? null : { minor: Math.round(li.lineTotal.toNumber() * 1000), currency: null },
    }));
  }
  return out;
}

export interface CorrectionColumns {
  valueText?: string | null;
  valueNumeric?: number | null;
  valueDate?: Date | null;
  currency?: string | null;
}

/**
 * Parses a human-typed correction into typed columns (422 UNPROCESSABLE on
 * unparseable values — never guess, per the normalizer's never-guess policy).
 */
export function parseCorrection(fieldKey: FieldKey, current: { currency: string | null }, raw: string): CorrectionColumns {
  const kind = FIELD_KINDS[fieldKey];
  const value = raw.trim();
  if (value === "") throw new ApiError("UNPROCESSABLE", `Value for ${fieldKey} must not be empty`);
  switch (kind) {
    case "TEXT":
      return { valueText: value, valueNumeric: null, valueDate: null };
    case "DATE": {
      const iso = parseDateToIso(value);
      if (!iso) throw new ApiError("UNPROCESSABLE", `Value for ${fieldKey} is not a parseable date`, { value });
      return { valueDate: new Date(`${iso}T00:00:00.000Z`), valueText: null, valueNumeric: null };
    }
    case "MONEY": {
      const milli = parseAmountToMilli(value);
      if (milli === null) throw new ApiError("UNPROCESSABLE", `Value for ${fieldKey} is not a parseable amount`, { value });
      return { valueNumeric: milli / 1000, currency: current.currency, valueText: null, valueDate: null };
    }
    case "WEIGHT_KG": {
      const { value: milli, unitUnknown } = parseWeightToMilliKg(value);
      if (milli === null) {
        throw new ApiError("UNPROCESSABLE", unitUnknown ? `Unit for ${fieldKey} is unknown` : `Value for ${fieldKey} is not a parseable weight`, { value });
      }
      return { valueNumeric: milli / 1000, valueText: null, valueDate: null };
    }
    case "COUNT": {
      const milli = parseAmountToMilli(value);
      if (milli === null || milli % 1000 !== 0) {
        throw new ApiError("UNPROCESSABLE", `Value for ${fieldKey} must be a whole number`, { value });
      }
      return { valueNumeric: milli / 1000, valueText: null, valueDate: null };
    }
    case "QTY": {
      const milli = parseAmountToMilli(value);
      if (milli === null) throw new ApiError("UNPROCESSABLE", `Value for ${fieldKey} is not a parseable quantity`, { value });
      return { valueNumeric: milli / 1000, valueText: null, valueDate: null };
    }
  }
}

/** sha256 for synthetic/real document provenance and CSV integrity lines. */
export function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
