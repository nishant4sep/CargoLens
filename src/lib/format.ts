/**
 * Pure display helpers for document UI (P4.3 upload screen). No React, no
 * I/O — unit-testable data mappings, same discipline as lib/dashboard.ts.
 */

/** Human file size; unknown/negative input degrades to an em dash. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"] as const;
  let value = bytes;
  let unit = -1;
  do {
    value /= 1024;
    unit++;
  } while (value >= 1024 && unit < units.length - 1);
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

const DOC_STATUS_LABELS: Record<string, string> = {
  UPLOADED: "Uploaded",
  PROCESSING: "Extracting",
  PROCESSED: "Processed",
  UNREADABLE: "Unreadable",
  FAILED: "Failed",
};

/** Per-document status label; unknown values render raw (honest UI). */
export function documentStatusLabel(status: string): string {
  return DOC_STATUS_LABELS[status] ?? status;
}

const DOC_TYPE_LABELS: Record<string, string> = {
  INVOICE: "Invoice",
  PACKING_LIST: "Packing list",
  BILL_OF_LADING: "Bill of lading",
};

/** Document-type label; unknown values render raw (honest UI). */
export function documentTypeLabel(type: string): string {
  return DOC_TYPE_LABELS[type] ?? type;
}
