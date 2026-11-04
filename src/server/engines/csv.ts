/**
 * Pure CSV writer for the gated export (contract row 16) — no I/O, fully
 * unit-tested. Deterministic bytes are part of the contract: the ExportRecord
 * stores csvContent + sha256 so "re-download exact history" is byte-true.
 *
 * A1 (flagged in README + notebook): the filing software's CSV layout is an
 * ASSUMPTION — `formatVersion: cargolens-csv-v1` in every ExportRecord marks
 * exactly which layout produced a file.
 */

export const CSV_FORMAT_VERSION = "cargolens-csv-v1";

/**
 * RFC-4180 escaping + a spreadsheet formula-injection guard: cells beginning
 * with = + - @ TAB or CR get a leading apostrophe (string cells only; numeric
 * values arrive as `number` and are emitted bare so "-45" is never mangled).
 */
export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  let s = typeof value === "number" ? String(value) : value;
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

export type ExportRow = Record<string, string | number | null | undefined>;

/** Joins rows with CRLF (RFC 4180) and terminates the final line. */
export function toCsv(header: readonly string[], rows: readonly ExportRow[]): string {
  const lines = [header.map(csvCell).join(",")];
  for (const r of rows) lines.push(header.map((h) => csvCell(r[h])).join(","));
  return lines.join("\r\n") + "\r\n";
}

/** The one CSV layout the broker's filing software receives (A1). */
export const EXPORT_HEADER = [
  "shipmentRef",
  "supplierName",
  "supplierCountry",
  "invoiceNumber",
  "invoiceDate",
  "currency",
  "incoterm",
  "totalValue",
  "grossWeightKg",
  "netWeightKg",
  "packagesCount",
  "containerNumber",
  "bolNumber",
  "vesselName",
  "portOfLoading",
  "portOfDischarge",
  "lineSeq",
  "lineDescription",
  "hsnCode",
  "quantity",
  "unit",
  "unitPrice",
  "lineTotal",
] as const;
