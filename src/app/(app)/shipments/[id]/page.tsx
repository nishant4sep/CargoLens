/**
 * Shipment detail + upload screen (PRD screens 2→4 bridge, plan P4.3):
 * real detail aggregate over the API (contract row 6), the three document
 * slots with the row-8 multipart upload behind them, and clear navigation
 * back to the dashboard. The review workspace replaces/extends this page in
 * P4.4 — the upload panel and documents table carry forward.
 */
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { apiFetch } from "@/server/api-fetch";
import { StatusChip } from "@/components/status-chip";
import { DocumentUpload, type ExistingDoc } from "@/components/document-upload";
import { ErrorBanner } from "@/components/states";
import { documentStatusLabel, documentTypeLabel, formatBytes } from "@/lib/format";

export const instant = false;

interface DetailResponse {
  shipment: {
    id: string;
    ref: string;
    status: string;
    createdAt: string;
    updatedAt: string;
    supplier: { id: string; name: string; country: string | null } | null;
  };
  metrics: {
    documentsCount: number;
    fieldsTotal: number;
    fieldsCleared: number;
    unresolvedBlockingFails: number;
  };
  documents: ExistingDoc[];
}

const fmt = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Asia/Kolkata",
});

export default async function ShipmentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = await apiFetch<DetailResponse>(`/api/shipments/${id}`);

  if (!result.ok) {
    if (result.status === 401) redirect("/login");
    if (result.status === 404) notFound(); // foreign or unknown id — object-level scoping
    return (
      <div className="space-y-4">
        <ErrorBanner code={result.error.code} message={result.error.message} details={result.error.details} />
        <Link href="/" className="inline-block text-sm font-medium text-zinc-700 underline underline-offset-4">
          Back to shipments
        </Link>
      </div>
    );
  }

  const { shipment: s, metrics, documents } = result.data;
  const exported = s.status === "EXPORTED";

  return (
    <div className="space-y-4">
      <Link href="/" className="inline-block text-sm text-zinc-500 hover:text-zinc-700">
        ← All shipments
      </Link>
      <div className="rounded-lg border border-zinc-200 bg-white p-6">
        <div className="flex items-center justify-between">
          <h1 className="font-mono text-lg font-semibold tracking-tight text-zinc-900">{s.ref}</h1>
          <StatusChip status={s.status} />
        </div>
        <dl className="mt-4 grid grid-cols-2 gap-x-8 gap-y-2 text-sm">
          <dt className="text-zinc-500">Supplier</dt>
          <dd className="text-zinc-900">
            {s.supplier ? `${s.supplier.name}${s.supplier.country ? ` (${s.supplier.country})` : ""}` : "—"}
          </dd>
          <dt className="text-zinc-500">Documents</dt>
          <dd className="text-zinc-900">{metrics.documentsCount} of 3</dd>
          <dt className="text-zinc-500">Blocking discrepancies</dt>
          <dd className={metrics.unresolvedBlockingFails > 0 ? "font-medium text-red-600" : "text-zinc-900"}>
            {metrics.unresolvedBlockingFails}
          </dd>
          <dt className="text-zinc-500">Fields cleared</dt>
          <dd className="text-zinc-900">
            {metrics.fieldsCleared}/{metrics.fieldsTotal}
          </dd>
          <dt className="text-zinc-500">Created</dt>
          <dd className="text-zinc-900">{fmt.format(new Date(s.createdAt))} IST</dd>
          <dt className="text-zinc-500">Updated</dt>
          <dd className="text-zinc-900">{fmt.format(new Date(s.updatedAt))} IST</dd>
        </dl>
      </div>

      {exported ? (
        <div className="rounded-lg border border-zinc-200 bg-white px-4 py-3 text-sm text-zinc-600">
          This shipment is <strong>exported</strong> — documents are locked and can no longer change.
        </div>
      ) : (
        <DocumentUpload shipmentId={s.id} documents={documents} />
      )}

      {documents.length > 0 ? (
        <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-zinc-200 text-xs font-medium text-zinc-500">
                <th className="px-4 py-2.5">Type</th>
                <th className="px-4 py-2.5">File</th>
                <th className="px-4 py-2.5">Size</th>
                <th className="px-4 py-2.5">Status</th>
                <th className="px-4 py-2.5 text-right">Extracted</th>
              </tr>
            </thead>
            <tbody>
              {documents.map((d) => (
                <tr key={d.id} className="border-b border-zinc-100 last:border-0 hover:bg-zinc-50">
                  <td className="px-4 py-3 font-medium text-zinc-900">{documentTypeLabel(d.type)}</td>
                  <td className="px-4 py-3 text-zinc-700">{d.fileName}</td>
                  <td className="px-4 py-3 text-zinc-500">{formatBytes(Number(d.sizeBytes))}</td>
                  <td className="px-4 py-3 text-zinc-700">{documentStatusLabel(d.status)}</td>
                  <td className="px-4 py-3 text-right text-zinc-500">
                    {d.extractedAt ? fmt.format(new Date(d.extractedAt)) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
