/**
 * Pure UI mappings for the dashboard (ADR-07 spirit: states drive attention,
 * never decoration). No React here — everything is unit-testable.
 */

/** The six machine states (file 03 §6 / state machine) — the ONLY chip set. */
export const SHIPMENT_STATUSES = [
  "DRAFT",
  "PROCESSING",
  "NEEDS_REVIEW",
  "READY_FOR_APPROVAL",
  "APPROVED",
  "EXPORTED",
] as const;

export type StatusTone = "zinc" | "sky" | "amber" | "violet" | "emerald" | "teal";

const TONES: Record<string, StatusTone> = {
  DRAFT: "zinc",
  PROCESSING: "sky",
  NEEDS_REVIEW: "amber",
  READY_FOR_APPROVAL: "violet",
  APPROVED: "emerald",
  EXPORTED: "teal",
};

/** Attention color for a status; unknown states fall back to neutral zinc. */
export function statusTone(status: string): StatusTone {
  return TONES[status] ?? "zinc";
}

const LABELS: Record<string, string> = {
  DRAFT: "Draft",
  PROCESSING: "Processing",
  NEEDS_REVIEW: "Needs review",
  READY_FOR_APPROVAL: "Ready for approval",
  APPROVED: "Approved",
  EXPORTED: "Exported",
};

/** Human label; unknown states render the raw machine value (honest UI). */
export function statusLabel(status: string): string {
  return LABELS[status] ?? status;
}

const TONE_CLASSES: Record<StatusTone, string> = {
  zinc: "border-zinc-200 bg-zinc-50 text-zinc-600",
  sky: "border-sky-200 bg-sky-50 text-sky-700",
  amber: "border-amber-200 bg-amber-50 text-amber-700",
  violet: "border-violet-200 bg-violet-50 text-violet-700",
  emerald: "border-emerald-200 bg-emerald-50 text-emerald-700",
  teal: "border-teal-200 bg-teal-50 text-teal-700",
};

/** Tailwind classes for a chip — a closed set, so it can be tested as data. */
export function statusToneClasses(status: string): string {
  return TONE_CLASSES[statusTone(status)];
}

export interface DashboardFilters {
  status?: string;
  q?: string;
  page: number;
}

/**
 * Coerce the dashboard's searchParams into list-query inputs. Anything the
 * contract would reject (unknown status, over-long q) is DROPPED here rather
 * than sent — the URL is user-editable, and a dirty URL should show the
 * unfiltered list, not an error page.
 */
export function parseDashboardFilters(
  params: Record<string, string | string[] | undefined>,
): DashboardFilters {
  const rawStatus = typeof params.status === "string" ? params.status : undefined;
  const rawQ = typeof params.q === "string" ? params.q : undefined;
  const rawPage = typeof params.page === "string" ? Number(params.page) : NaN;
  return {
    status: rawStatus && (SHIPMENT_STATUSES as readonly string[]).includes(rawStatus) ? rawStatus : undefined,
    q: rawQ && rawQ.trim() !== "" && rawQ.length <= 80 ? rawQ.trim() : undefined,
    page: Number.isInteger(rawPage) && rawPage >= 1 && rawPage <= 10_000 ? rawPage : 1,
  };
}
