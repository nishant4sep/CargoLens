/**
 * Shipment detail — P4.2 BRIDGE version: proves row navigation end to end
 * with real data from the detail aggregate (contract row 6), and is replaced
 * by the review screen in P4.4 (the product). Minimal on purpose.
 */
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { apiFetch } from "@/server/api-fetch";
import { StatusChip } from "@/components/status-chip";
import { ErrorBanner } from "@/components/states";

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

  const { shipment: s, metrics } = result.data;

  return (
    <div className="mx-auto max-w-3xl space-y-4">
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
          <dd className="text-zinc-900">{s.supplier ? `${s.supplier.name}${s.supplier.country ? ` (${s.supplier.country})` : ""}` : "—"}</dd>
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
      <p className="text-xs text-zinc-400">
        The review workspace — document viewer beside fields, confirm/correct, cross-check resolution —
        arrives in P4.4. This page is the navigation bridge.
      </p>
    </div>
  );
}
