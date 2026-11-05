/**
 * Screen 2 (PRD §8) — the shipment dashboard. A server component that reads
 * its data through the REAL API over HTTP (`apiFetch`, cookie-forwarded) —
 * the API is a deliverable, so the UI proves the contract, and PostgreSQL
 * via the API is the only source of the numbers on screen. No charts, no
 * decorative cards: one dense table, filters, actions.
 *
 * Filters are plain GET links/forms (server-rendered, zero client JS):
 * status chips + free-text search on the shipment ref (`q`, contract row 4).
 */
import Link from "next/link";
import { redirect } from "next/navigation";
import { apiFetch } from "@/server/api-fetch";
import { parseDashboardFilters, SHIPMENT_STATUSES, statusLabel } from "@/lib/dashboard";
import { StatusChip } from "@/components/status-chip";
import { NewShipmentButton } from "@/components/new-shipment-button";
import { EmptyState, ErrorBanner } from "@/components/states";

export const instant = false;

interface ListResponse {
  items: Array<{
    id: string;
    ref: string;
    status: string;
    updatedAt: string;
    supplier: { id: string; name: string; country: string | null } | null;
    _count: { documents: number; checks: number };
    blockingFails: number;
  }>;
  page: number;
  total: number;
  hasMore: boolean;
}

const PAGE_SIZE = 20;
const fmt = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Asia/Kolkata", // India-hosted product (ADR-04) — IST display is deliberate
});

function chipHref(status: string | undefined, q: string | undefined): string {
  const qs = new URLSearchParams();
  if (status) qs.set("status", status);
  if (q) qs.set("q", q);
  return `/${qs.toString() ? `?${qs}` : ""}`;
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const filters = parseDashboardFilters(await searchParams);
  const qs = new URLSearchParams();
  if (filters.status) qs.set("status", filters.status);
  if (filters.q) qs.set("q", filters.q);
  if (filters.page > 1) qs.set("page", String(filters.page));

  const result = await apiFetch<ListResponse>(`/api/shipments${qs.toString() ? `?${qs}` : ""}`);

  if (!result.ok) {
    if (result.status === 401) redirect("/login"); // defense in depth — the layout guard already ran
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-semibold tracking-tight text-zinc-900">Shipments</h1>
          <NewShipmentButton />
        </div>
        <ErrorBanner code={result.error.code} message={result.error.message} details={result.error.details} />
        <Link href="/" className="inline-block text-sm font-medium text-zinc-700 underline underline-offset-4">
          Retry
        </Link>
      </div>
    );
  }

  const { items, page, total, hasMore } = result.data;
  const filtered = filters.status !== undefined || filters.q !== undefined;
  const from = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const to = Math.min(page * PAGE_SIZE, total);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold tracking-tight text-zinc-900">Shipments</h1>
          <p className="text-sm text-zinc-500">{total} total</p>
        </div>
        <NewShipmentButton />
      </div>

      {/* Status filter chips + ref search (GET form — no client JS needed) */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <nav className="flex flex-wrap gap-1" aria-label="Filter by status">
          <Link
            href={chipHref(undefined, filters.q)}
            className={`rounded-full border px-2.5 py-1 text-xs font-medium ${!filters.status ? "border-zinc-900 bg-zinc-900 text-white" : "border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-50"}`}
          >
            All
          </Link>
          {SHIPMENT_STATUSES.map((s) => (
            <Link
              key={s}
              href={chipHref(s, filters.q)}
              className={`rounded-full border px-2.5 py-1 text-xs font-medium ${filters.status === s ? "border-zinc-900 bg-zinc-900 text-white" : "border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-50"}`}
            >
              {statusLabel(s)}
            </Link>
          ))}
        </nav>
        <form method="get" action="/" className="flex items-center gap-2">
          {filters.status ? <input type="hidden" name="status" value={filters.status} /> : null}
          <input
            type="search"
            name="q"
            defaultValue={filters.q ?? ""}
            placeholder="Search reference…"
            maxLength={80}
            className="w-56 rounded-md border border-zinc-300 px-3 py-1.5 text-sm text-zinc-900 placeholder-zinc-400 focus:border-zinc-900 focus:outline-none focus:ring-1 focus:ring-zinc-900"
          />
          <button
            type="submit"
            className="rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
          >
            Search
          </button>
        </form>
      </div>

      {items.length === 0 ? (
        filtered ? (
          <EmptyState
            title="No shipments match"
            message="No shipment has this status and reference combination. Adjust or clear the filters."
            action={
              <Link href="/" className="text-sm font-medium text-zinc-700 underline underline-offset-4">
                Clear filters
              </Link>
            }
          />
        ) : (
          <EmptyState
            title="No shipments yet"
            message="Create the first shipment, then upload its invoice, packing list and bill of lading."
            action={<NewShipmentButton label="Create the first shipment" />}
          />
        )
      ) : (
        <>
          <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-zinc-200 text-xs font-medium text-zinc-500">
                  <th className="px-4 py-2.5">Reference</th>
                  <th className="px-4 py-2.5">Supplier</th>
                  <th className="px-4 py-2.5">Docs</th>
                  <th className="px-4 py-2.5">Status</th>
                  <th className="px-4 py-2.5">Blocking</th>
                  <th className="px-4 py-2.5 text-right">Updated</th>
                </tr>
              </thead>
              <tbody>
                {items.map((s) => (
                  <tr key={s.id} className="border-b border-zinc-100 last:border-0 hover:bg-zinc-50">
                    <td className="px-4 py-3">
                      <Link
                        href={`/shipments/${s.id}`}
                        className="font-mono text-sm font-medium text-zinc-900 underline-offset-4 hover:underline"
                      >
                        {s.ref}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-zinc-700">
                      {s.supplier ? s.supplier.name : <span className="text-zinc-400">—</span>}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className="inline-flex items-center gap-1"
                        title={`${s._count.documents} of 3 documents uploaded`}
                      >
                        {[0, 1, 2].map((i) => (
                          <span
                            key={i}
                            className={`inline-block h-1.5 w-1.5 rounded-full ${i < s._count.documents ? "bg-zinc-900" : "bg-zinc-200"}`}
                          />
                        ))}
                        <span className="ml-1 text-xs text-zinc-500">{s._count.documents}/3</span>
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <StatusChip status={s.status} />
                    </td>
                    <td className="px-4 py-3">
                      {s.blockingFails > 0 ? (
                        <span className="font-medium text-red-600" title="Unresolved blocking cross-check failures">
                          ⚠ {s.blockingFails}
                        </span>
                      ) : (
                        <span className="text-zinc-300">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right text-zinc-500">{fmt.format(new Date(s.updatedAt))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between text-xs text-zinc-500">
            <span>
              Showing {from}–{to} of {total}
            </span>
            {page > 1 || hasMore ? (
              <span className="flex gap-2">
                {page > 1 ? (
                  <Link
                    href={chipHref(filters.status, filters.q) + (chipHref(filters.status, filters.q).includes("?") ? "&" : "?") + `page=${page - 1}`}
                    className="rounded-md border border-zinc-200 bg-white px-2.5 py-1 font-medium text-zinc-700 hover:bg-zinc-50"
                  >
                    ← Previous
                  </Link>
                ) : null}
                {hasMore ? (
                  <Link
                    href={chipHref(filters.status, filters.q) + (chipHref(filters.status, filters.q).includes("?") ? "&" : "?") + `page=${page + 1}`}
                    className="rounded-md border border-zinc-200 bg-white px-2.5 py-1 font-medium text-zinc-700 hover:bg-zinc-50"
                  >
                    Next →
                  </Link>
                ) : null}
              </span>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}
