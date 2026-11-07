/**
 * Pure accuracy-report mappings (P4.6, contract row 19 + row 4). The brief's
 * rule: only ACTUAL persisted and verifiable data — every number here is a
 * deterministic derivation from an API response the server already serves;
 * nothing is modeled, sampled, or extrapolated. Missing data renders as an
 * honest null/empty state, never a fabricated zero or percentage.
 *
 * The FOUR metrics are kept DISTINCT by definition:
 *  - correction rate   — corrected fields ÷ reviewed fields (a WORKLOAD /
 *                        agreement signal, NOT accuracy: it cannot see the
 *                        wrong values humans failed to catch);
 *  - review workload   — plain counts of human-cleared fields + shipments
 *                        per status (no percentages without a denominator
 *                        story);
 *  - discrepancy load  — shipments carrying unresolved BLOCKING FAILs right
 *                        now (from the list aggregate's blockingFails);
 *  - verified accuracy — NOT computable in this build: the schema persists
 *                        no ground-truth source, so any percentage would be
 *                        fabricated. verifiedAccuracy() exists to make that
 *                        impossibility explicit and single-sited.
 *
 * Known conflation (documented on screen): until Phase 5's AI extraction
 * exists, a CORRECTED field may be a human correcting their OWN manual
 * entry — row 19 exposes status, not original-extraction provenance.
 */
import { fieldLabel } from "@/lib/review";

/* ------------------------------ row 19 shapes ----------------------------- */

export interface AccuracyFieldRow {
  fieldKey: string;
  total: number;
  aiDraft: number;
  confirmed: number; // CONFIRMED + CORRECTED + MANUAL_ENTERED (the service's sum)
  corrected: number;
  manualEntered: number;
  avgConfidence: string | null; // Decimal-as-string "0.930"
}

export interface AccuracySupplierRow {
  supplierId: string | null;
  supplierName: string | null;
  shipments: number;
  fieldsTotal: number;
  fieldsCleared: number;
  avgConfidence: string | null;
}

/* ------------------------------- row 4 shape ------------------------------ */

export interface ShipmentListItem {
  ref: string;
  status: string;
  blockingFails: number;
}

/* --------------------------- the calculations ----------------------------- */

/** Exact rational → percent with ONE decimal, or null when the denominator is
 *  zero (no data ≠ 0% — the empty state is the honest answer). */
export function ratePercent(numerator: number, denominator: number): string | null {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return null;
  return `${(Math.round((numerator / denominator) * 1000) / 10).toFixed(1)}%`;
}

/** Decimal-as-string confidence → "93%"; null stays null (never invented). */
export function confidenceDisplay(avgConfidence: string | null): string | null {
  if (avgConfidence === null) return null;
  const n = Number(avgConfidence);
  if (!Number.isFinite(n) || n < 0 || n > 1) return null;
  return `${Math.round(n * 100)}%`;
}

export interface FieldReportRow {
  field: string; // human label; unknown keys render raw
  total: number;
  aiDraft: number;
  confirmed: number;
  corrected: number;
  manualEntered: number;
  /** corrected ÷ total — the correction RATE; null when the field has no rows */
  correctionRate: string | null;
  avgConfidence: string | null;
}

/** One display row per field key, sorted by volume then key (the service's
 *  order, preserved so the API's determinism shows). */
export function fieldReportRows(rows: AccuracyFieldRow[]): FieldReportRow[] {
  return rows.map((r) => ({
    field: fieldLabel(r.fieldKey),
    total: r.total,
    aiDraft: r.aiDraft,
    confirmed: r.confirmed,
    corrected: r.corrected,
    manualEntered: r.manualEntered,
    correctionRate: ratePercent(r.corrected, r.total),
    avgConfidence: confidenceDisplay(r.avgConfidence),
  }));
}

export interface SupplierReportRow {
  supplier: string; // "No supplier" for the null bucket
  shipments: number;
  fieldsTotal: number;
  fieldsCleared: number;
  /** cleared ÷ total — how much of the supplier's data is human-cleared */
  clearedShare: string | null;
  avgConfidence: string | null;
}

export function supplierReportRows(rows: AccuracySupplierRow[]): SupplierReportRow[] {
  return rows.map((r) => ({
    supplier: r.supplierName ?? "No supplier",
    shipments: r.shipments,
    fieldsTotal: r.fieldsTotal,
    fieldsCleared: r.fieldsCleared,
    clearedShare: ratePercent(r.fieldsCleared, r.fieldsTotal),
    avgConfidence: confidenceDisplay(r.avgConfidence),
  }));
}

/* ------------------------- workload + discrepancies ----------------------- */

export interface WorkloadSummary {
  total: number;
  byStatus: Record<string, number>;
  /** shipments currently carrying ≥1 unresolved BLOCKING FAIL — the open
   *  discrepancy workload (resolved-with-note totals are per-shipment only;
   *  the contract has no cross-shipment check aggregate — documented). */
  openBlocking: Array<{ ref: string; blockingFails: number }>;
  truncated: boolean; // list pagination hit the fetch cap — counts are a lower bound
}

const STATUS_ORDER = ["DRAFT", "PROCESSING", "NEEDS_REVIEW", "READY_FOR_APPROVAL", "APPROVED", "EXPORTED"];

/** Aggregates the shipment list (rows 4, all pages up to `maxPages`) into the
 *  workload histogram + open-discrepancy list. Deterministic; `truncated`
 *  flags when the cap bit (honest lower bound, never a silent one). */
export function workloadSummary(items: ShipmentListItem[], truncated = false): WorkloadSummary {
  const byStatus: Record<string, number> = {};
  for (const status of STATUS_ORDER) byStatus[status] = 0;
  for (const item of items) byStatus[item.status] = (byStatus[item.status] ?? 0) + 1;
  return {
    total: items.length,
    byStatus,
    openBlocking: items
      .filter((i) => i.blockingFails > 0)
      .map((i) => ({ ref: i.ref, blockingFails: i.blockingFails }))
      .sort((a, b) => b.blockingFails - a.blockingFails || a.ref.localeCompare(b.ref)),
    truncated,
  };
}

/* ------------------------- verified accuracy (honest) --------------------- */

export interface VerifiedAccuracyState {
  available: false;
  reason: string;
}

/**
 * Verified extraction accuracy requires GROUND TRUTH — an independent
 * reference to score extractions against. This build persists none: no
 * ground-truth column, no verified-source documents, no sampling harness.
 * The function always returns `available: false` with that reason; when a
 * ground-truth source lands (Phase 5+), THIS is the single place to change —
 * and the test asserting `available === false` is the tripwire that forces
 * the honest rewrite instead of a silent fabricated percentage.
 */
export function verifiedAccuracy(): VerifiedAccuracyState {
  return {
    available: false,
    reason:
      "Not measurable in this build — no ground-truth source is persisted. A correction rate is not accuracy: it cannot see the mistakes humans confirm without noticing. Verified percentages will appear only when an extraction run can be scored against an independent reference.",
  };
}
