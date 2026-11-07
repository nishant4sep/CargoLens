/**
 * Screen 6 (PRD §8) — the accuracy & workload report (P4.6, contract rows 4
 * and 19). A server component reading the REAL API over HTTP (`apiFetch`) —
 * no new endpoints, no analytics layer, no charts: plain counts and group-bys
 * over persisted rows, displayed with their denominators.
 *
 * Honesty rules (the brief): the four metrics are kept distinct — correction
 * rate is a workload signal, NOT accuracy; verified extraction accuracy is
 * NOT shown because no ground truth exists in this build (see
 * verifiedAccuracy()); empty data renders an explicit empty state, never a
 * fabricated zero or percentage.
 */
import Link from "next/link";
import { apiFetch } from "@/server/api-fetch";
import { EmptyState, ErrorBanner } from "@/components/states";
import { statusLabel, statusToneClasses } from "@/lib/dashboard";
import {
  fieldReportRows,
  supplierReportRows,
  verifiedAccuracy,
  workloadSummary,
  type AccuracyFieldRow,
  type AccuracySupplierRow,
  type ShipmentListItem,
} from "@/lib/accuracy";

export const instant = false;

const LIST_PAGE_CAP = 10; // 10 × 20 = 200 shipments before the honest "lower bound" flag

/** Fetches EVERY page of the shipment list (up to the cap) — the workload
 *  histogram and open-discrepancy list must cover all shipments, not page 1. */
async function fetchAllShipments(): Promise<{ items: ShipmentListItem[]; truncated: boolean }> {
  const items: ShipmentListItem[] = [];
  for (let page = 1; page <= LIST_PAGE_CAP; page++) {
    const res = await apiFetch<{ items: ShipmentListItem[]; hasMore: boolean }>(`/api/shipments?page=${page}`);
    if (!res.ok) throw new Error(`list page ${page}: ${res.error.message}`);
    items.push(...res.data.items);
    if (!res.data.hasMore) return { items, truncated: false };
  }
  return { items, truncated: true }; // cap hit — counts are a lower bound, flagged on screen
}

export default async function AccuracyPage() {
  const [byField, bySupplier, list] = await Promise.all([
    apiFetch<{ groupBy: string; rows: AccuracyFieldRow[] }>("/api/reports/accuracy?groupBy=field"),
    apiFetch<{ groupBy: string; rows: AccuracySupplierRow[] }>("/api/reports/accuracy?groupBy=supplier"),
    fetchAllShipments().catch((e: Error) => e),
  ]);

  if (!byField.ok) {
    return <ErrorBanner code={byField.error.code} message={byField.error.message} details={byField.error.details} />;
  }
  if (!bySupplier.ok) {
    return <ErrorBanner code={bySupplier.error.code} message={bySupplier.error.message} details={bySupplier.error.details} />;
  }
  if (list instanceof Error) {
    return <ErrorBanner code="REPORT_FAILED" message={`Workload data unavailable: ${list.message}`} />;
  }

  const fieldRows = fieldReportRows(byField.data.rows);
  const supplierRows = supplierReportRows(bySupplier.data.rows);
  const workload = workloadSummary(list.items, list.truncated);
  const verified = verifiedAccuracy();

  return (
    <div className="space-y-4">
      <Link href="/" className="inline-block text-sm text-zinc-500 hover:text-zinc-700">
        ← All shipments
      </Link>

      <div className="rounded-lg border border-zinc-200 bg-white p-6">
        <h1 className="text-lg font-semibold tracking-tight text-zinc-900">Accuracy &amp; workload</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Plain group-bys over persisted field rows (contract row 19) and the shipment list (row 4) — every number is
          traceable to a database aggregate; nothing is modeled or sampled.
        </p>
      </div>

      {/* ---- verified accuracy: the honest permanent empty state ---- */}
      <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
        <p className="text-sm font-medium text-amber-800">Verified extraction accuracy: not measurable yet</p>
        <p className="mt-1 text-xs text-amber-700">{verified.reason}</p>
      </div>

      {/* ---- review workload ---- */}
      <div className="rounded-lg border border-zinc-200 bg-white">
        <div className="border-b border-zinc-200 px-4 py-3">
          <h2 className="text-sm font-semibold text-zinc-900">Review workload</h2>
          <p className="mt-0.5 text-xs text-zinc-500">
            Shipments by machine state
            {workload.truncated ? " — list cap hit, counts are a LOWER BOUND" : ""}. Counts only; no invented
            percentages.
          </p>
        </div>
        {workload.total === 0 ? (
          <div className="px-4 py-6">
            <EmptyState title="No shipments yet" message="Workload appears as soon as shipments exist." />
          </div>
        ) : (
          <div className="flex flex-wrap gap-2 px-4 py-4">
            {Object.entries(workload.byStatus)
              .filter(([, n]) => n > 0)
              .map(([status, n]) => (
                <span key={status} className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium ${statusToneClasses(status)}`}>
                  {statusLabel(status)}
                  <span className="font-mono">{n}</span>
                </span>
              ))}
          </div>
        )}
      </div>

      {/* ---- open discrepancies (workload, distinct from resolution history) ---- */}
      <div className="rounded-lg border border-zinc-200 bg-white">
        <div className="border-b border-zinc-200 px-4 py-3">
          <h2 className="text-sm font-semibold text-zinc-900">Open discrepancies</h2>
          <p className="mt-0.5 text-xs text-zinc-500">
            Shipments carrying unresolved BLOCKING FAILs right now. Resolved-with-note history lives per shipment (each
            review screen&apos;s audit tab) — the contract has no cross-shipment check aggregate, and this page does not
            invent one.
          </p>
        </div>
        {workload.openBlocking.length === 0 ? (
          <p className="px-4 py-4 text-sm text-zinc-500">None — no shipment is blocked from approval right now.</p>
        ) : (
          <ul className="divide-y divide-zinc-100">
            {workload.openBlocking.map((o) => (
              <li key={o.ref} className="flex items-center justify-between px-4 py-2.5 text-sm">
                <span className="font-mono text-zinc-900">{o.ref}</span>
                <span className="font-medium text-red-600">
                  {o.blockingFails} unresolved blocking {o.blockingFails === 1 ? "discrepancy" : "discrepancies"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* ---- correction rate per field ---- */}
      <div className="rounded-lg border border-zinc-200 bg-white">
        <div className="border-b border-zinc-200 px-4 py-3">
          <h2 className="text-sm font-semibold text-zinc-900">Correction rate per field</h2>
          <p className="mt-0.5 text-xs text-zinc-500">
            corrected ÷ total, per field key — a review-workload signal, NOT accuracy. Caveat: until AI extraction
            lands (Phase 5), a CORRECTED field may be a human correcting their own manual entry; row 19 exposes status,
            not original-extraction provenance.
          </p>
        </div>
        {fieldRows.length === 0 ? (
          <div className="px-4 py-6">
            <EmptyState title="No extraction data yet" message="Field rows appear as soon as documents carry extracted data." />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-zinc-200 text-xs font-medium text-zinc-500">
                  <th className="px-4 py-2.5">Field</th>
                  <th className="px-4 py-2.5 text-right">Total</th>
                  <th className="px-4 py-2.5 text-right">AI draft</th>
                  <th className="px-4 py-2.5 text-right">Confirmed</th>
                  <th className="px-4 py-2.5 text-right">Corrected</th>
                  <th className="px-4 py-2.5 text-right">Manual</th>
                  <th className="px-4 py-2.5 text-right">Correction rate</th>
                  <th className="px-4 py-2.5 text-right">Avg confidence</th>
                </tr>
              </thead>
              <tbody>
                {fieldRows.map((r) => (
                  <tr key={r.field} className="border-b border-zinc-100 last:border-0">
                    <td className="px-4 py-2 font-medium text-zinc-900">{r.field}</td>
                    <td className="px-4 py-2 text-right font-mono text-[13px] text-zinc-900">{r.total}</td>
                    <td className="px-4 py-2 text-right font-mono text-[13px] text-zinc-500">{r.aiDraft}</td>
                    <td className="px-4 py-2 text-right font-mono text-[13px] text-zinc-900">{r.confirmed}</td>
                    <td className="px-4 py-2 text-right font-mono text-[13px] text-zinc-900">{r.corrected}</td>
                    <td className="px-4 py-2 text-right font-mono text-[13px] text-zinc-900">{r.manualEntered}</td>
                    <td className={`px-4 py-2 text-right font-mono text-[13px] ${r.correctionRate === null ? "text-zinc-400" : "text-zinc-900"}`}>
                      {r.correctionRate ?? "— no data"}
                    </td>
                    <td className={`px-4 py-2 text-right font-mono text-[13px] ${r.avgConfidence === null ? "text-zinc-400" : "text-zinc-900"}`}>
                      {r.avgConfidence ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ---- per supplier ---- */}
      <div className="rounded-lg border border-zinc-200 bg-white">
        <div className="border-b border-zinc-200 px-4 py-3">
          <h2 className="text-sm font-semibold text-zinc-900">Data readiness per supplier</h2>
          <p className="mt-0.5 text-xs text-zinc-500">
            Human-cleared share of each supplier&apos;s extracted fields — where review effort concentrates, and which
            suppliers&apos; documents still owe the pipeline data.
          </p>
        </div>
        {supplierRows.length === 0 ? (
          <div className="px-4 py-6">
            <EmptyState title="No supplier data yet" message="Supplier rows appear once shipments carry extracted fields." />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-zinc-200 text-xs font-medium text-zinc-500">
                  <th className="px-4 py-2.5">Supplier</th>
                  <th className="px-4 py-2.5 text-right">Shipments</th>
                  <th className="px-4 py-2.5 text-right">Fields</th>
                  <th className="px-4 py-2.5 text-right">Human-cleared</th>
                  <th className="px-4 py-2.5 text-right">Cleared share</th>
                  <th className="px-4 py-2.5 text-right">Avg confidence</th>
                </tr>
              </thead>
              <tbody>
                {supplierRows.map((r) => (
                  <tr key={`${r.supplier}-${r.shipments}`} className="border-b border-zinc-100 last:border-0">
                    <td className="px-4 py-2 font-medium text-zinc-900">{r.supplier}</td>
                    <td className="px-4 py-2 text-right font-mono text-[13px] text-zinc-900">{r.shipments}</td>
                    <td className="px-4 py-2 text-right font-mono text-[13px] text-zinc-900">{r.fieldsTotal}</td>
                    <td className="px-4 py-2 text-right font-mono text-[13px] text-zinc-900">{r.fieldsCleared}</td>
                    <td className={`px-4 py-2 text-right font-mono text-[13px] ${r.clearedShare === null ? "text-zinc-400" : "text-zinc-900"}`}>
                      {r.clearedShare ?? "— no data"}
                    </td>
                    <td className={`px-4 py-2 text-right font-mono text-[13px] ${r.avgConfidence === null ? "text-zinc-400" : "text-zinc-900"}`}>
                      {r.avgConfidence ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
