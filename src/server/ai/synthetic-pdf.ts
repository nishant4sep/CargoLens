/**
 * Synthetic import-document generator (Phase 5, P5.0) — pure, deterministic.
 *
 * WHY: the brief forbids real customer documents anywhere in the repo, and the
 * seed fixtures are the established ground truth — so the demo corpus is
 * GENERATED from those same fixtures (SHP-24812 clean / SHP-24811 dirty), and
 * one value set exercises the whole pipeline:
 *   generator → PDF bytes → [real Gemini vision | stub text reader] →
 *   RawExtraction → parseCorrection → typed columns == fixture spec (asserted
 *   by tests, so a generator bug cannot silently fake a passing pipeline).
 *
 * The PDFs are minimal but REAL single-page PDF 1.4 files (valid xref, Helvetica
 * text layer) — enough for a vision model to read and for text tools to parse.
 * Document text is ASCII-only; no secrets, no real parties (all names are the
 * seed's synthetic companies).
 */
import { FIELD_KINDS, type DocType, type FieldKey, type TypedFieldValue } from "@/lib/types";
import type { DemoDocSpec, DemoShipmentSpec } from "@/server/seed/fixtures";
import { DEMO_SHIPMENTS } from "@/server/seed/fixtures";

/** One unambiguous printed label per field key — shared by the generator and
 *  the stub reader, so a label can never drift between "written" and "read". */
export const DOC_LABELS: Record<FieldKey, string> = {
  supplierName: "Supplier",
  supplierAddress: "Supplier Address",
  supplierCountry: "Supplier Country",
  consigneeName: "Consignee",
  consigneeAddress: "Consignee Address",
  invoiceNumber: "Invoice No",
  invoiceDate: "Invoice Date",
  currency: "Currency",
  incoterm: "Incoterm",
  totalValue: "Total Value",
  packagesCount: "Packages",
  packageType: "Package Type",
  grossWeightKg: "Gross Weight",
  netWeightKg: "Net Weight",
  containerNumber: "Container No",
  bolNumber: "BOL No",
  vesselName: "Vessel",
  portOfLoading: "Port of Loading",
  portOfDischarge: "Port of Discharge",
};

const TITLES: Record<DocType, string> = {
  INVOICE: "COMMERCIAL INVOICE",
  PACKING_LIST: "PACKING LIST",
  BILL_OF_LADING: "BILL OF LADING",
};

function fmt(n: number, dp = 2): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

/** Engine typed value → the string printed on the synthetic page. */
function valueToDisplay(v: TypedFieldValue): string {
  switch (v.kind) {
    case "TEXT":
    case "DATE":
      return v.value;
    case "MONEY":
      return `${v.currency ?? ""} ${fmt(v.value / 1000)}`.trim();
    case "WEIGHT_KG":
      return `${fmt(v.value / 1000)} kg`;
    case "COUNT":
      return String(v.value);
    case "QTY":
      return fmt(v.value / 1000);
  }
}

function itemLine(li: DemoDocSpec["lineItems"][number]): string {
  const qty = li.qtyMilli / 1000;
  const price = li.unitPriceMilli / 1000;
  const total = Number((BigInt(li.qtyMilli) * BigInt(li.unitPriceMilli)) / 1_000_000n);
  return `Item ${li.seq}: ${li.description} | HSN: ${li.hsnCode ?? "-"} | ${qty}${li.unit ? ` ${li.unit}` : ""} x ${fmt(price)} = ${fmt(total)}`;
}

/** A document's full page text: title, `Label: value` lines, blank line, items. */
export function docLines(doc: DemoDocSpec): string[] {
  const lines: string[] = [TITLES[doc.type], ""];
  for (const [key, value] of Object.entries(doc.fields) as [FieldKey, TypedFieldValue][]) {
    lines.push(`${DOC_LABELS[key]}: ${valueToDisplay(value)}`);
  }
  if (doc.lineItems.length > 0) {
    lines.push("");
    for (const li of doc.lineItems) lines.push(itemLine(li));
  }
  return lines;
}

/* ------------------------------ the PDF writer ----------------------------- */

function pdfEscape(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

/** Builds a minimal, VALID single-page PDF (correct xref offsets) from lines. */
export function buildPdf(lines: string[]): Buffer {
  let stream = "";
  let y = 750;
  for (const line of lines) {
    stream += `BT /F1 11 Tf 40 ${y} Td (${pdfEscape(line)}) Tj ET\n`;
    y -= 20;
  }
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}endstream`,
  ];

  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(Buffer.byteLength(body, "latin1"));
    body += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xrefStart = Buffer.byteLength(body, "latin1");
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) xref += `${String(off).padStart(10, "0")} 00000 n \n`;
  body += `${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return Buffer.from(body, "latin1");
}

/** One shipment document → PDF bytes. */
export function syntheticDocPdf(doc: DemoDocSpec): Buffer {
  return buildPdf(docLines(doc));
}

/** A shipment's three document PDFs, keyed by DocType. */
export function syntheticTrio(spec: DemoShipmentSpec): Record<DocType, Buffer> {
  const out = {} as Record<DocType, Buffer>;
  for (const doc of spec.docs) out[doc.type] = syntheticDocPdf(doc);
  return out;
}

/** Fixed-letter noise page — the UNREADABLE "scan" (deterministic, no random). */
export function syntheticNoisePdf(): Buffer {
  return buildPdf([
    "QWZK XJVF OTPQ BNMV LDKJ",
    "HRTY UCSA MWEI ZXCX PLKM",
    "QASW DFVGB HNJUK MIOLP",
    "ZZKV MMPQ RTYU WXCV BNML",
  ]);
}

/** The demo corpus: the seed's own two shipments. */
export const SYNTHETIC_SET: Record<"clean" | "dirty", DemoShipmentSpec> = {
  clean: DEMO_SHIPMENTS.find((s) => s.ref === "SHP-24812")!,
  dirty: DEMO_SHIPMENTS.find((s) => s.ref === "SHP-24811")!,
};

/** Numeric-kind check shared with the stub reader (labels only; kinds decide). */
export function isNumericKind(key: FieldKey): boolean {
  return FIELD_KINDS[key] !== "TEXT" && FIELD_KINDS[key] !== "DATE";
}
