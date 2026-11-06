"use client";

/**
 * Extracted-fields panel (P4.4 field review): one row per field of the
 * selected document — label, value, confidence (when the AI supplied one),
 * provenance status, and confirm/correct controls.
 *
 * Contract discipline:
 *  - corrections PATCH the row-12 endpoint; the body is validated with the
 *    SERVER'S OWN PatchFieldDto (same Zod object) before any network;
 *  - the server's parseCorrection is the ONLY normalizer — a value it rejects
 *    (422) is shown VERBATIM and nothing is converted silently client-side;
 *  - confidence renders ONLY when the row carries one (manual entries have
 *    none — inventing one would lie about provenance);
 *  - a saved response replaces the row immediately (server truth), then
 *    router.refresh() pulls the recomputed checks/metrics.
 */
import { useRouter } from "next/navigation";
import { useState } from "react";
import { parseEnvelope } from "@/lib/envelope";
import {
  confidencePercent,
  fieldLabel,
  fieldStatusLabel,
  formatFieldValue,
  isLowConfidence,
  rawEditableValue,
  type ReviewField,
} from "@/lib/review";
import { PatchFieldDto } from "@/server/dto";

const chip = "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium";

function StatusChip({ status }: { status: string }) {
  const tone =
    status === "AI_DRAFT"
      ? "bg-amber-50 text-amber-700 ring-1 ring-inset ring-amber-200"
      : status === "MANUAL_ENTERED"
        ? "bg-sky-50 text-sky-700 ring-1 ring-inset ring-sky-200"
        : "bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-200"; // CONFIRMED / CORRECTED
  return <span className={`${chip} ${tone}`}>{fieldStatusLabel(status)}</span>;
}

export function FieldsPanel({
  shipmentId,
  fields,
  requiredKeys,
  canCorrect,
}: {
  shipmentId: string;
  fields: ReviewField[];
  requiredKeys: readonly string[];
  canCorrect: boolean;
}) {
  const router = useRouter();
  const [overrides, setOverrides] = useState<Record<string, ReviewField>>({});
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);

  const rows = fields.map((f) => overrides[f.id] ?? f);
  const present = new Set(fields.map((f) => f.fieldKey));
  const missingRequired = requiredKeys.filter((k) => !present.has(k));

  async function apply(field: ReviewField, body: Record<string, unknown>) {
    setBusyId(field.id);
    setError(null);
    try {
      const res = await fetch(`/api/shipments/${shipmentId}/fields/${field.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(body),
      });
      const parsed = await parseEnvelope<{ field: Record<string, unknown> }>(res);
      if (!parsed.ok) {
        setError({ code: parsed.error.code, message: parsed.error.message }); // 422/409 verbatim
        return;
      }
      setOverrides((prev) => ({ ...prev, [field.id]: { ...field, ...toUpdated(parsed.data.field, field) } }));
      setEditingId(null);
      router.refresh(); // checks, metrics and the shipment status just changed
    } catch {
      setError({ code: "NETWORK", message: "Could not reach the server. Try again." });
    } finally {
      setBusyId(null);
    }
  }

  function save(field: ReviewField) {
    const value = draft.trim();
    if (!value) {
      setError({ code: "VALIDATION_ERROR", message: "Value must not be empty" });
      return;
    }
    const check = PatchFieldDto.safeParse({ value });
    if (!check.success) {
      setError({ code: "VALIDATION_ERROR", message: "Value must be at most 200 characters" });
      return;
    }
    void apply(field, check.data);
  }

  const rowBase = "flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-2.5 text-sm";
  return (
    <div className="rounded-lg border border-zinc-200 bg-white">
      <div className="border-b border-zinc-200 px-4 py-3">
        <h3 className="text-sm font-semibold text-zinc-900">Extracted fields</h3>
        <p className="mt-0.5 text-xs text-zinc-500">
          Confidence is shown only where extraction provided it. Values below {Math.round(0.9 * 100)}% are marked uncertain.
        </p>
      </div>
      {error ? (
        <div className="border-b border-red-200 bg-red-50 px-4 py-2">
          <p className="text-xs font-medium text-red-700">
            {error.code === "NETWORK" ? "Save failed" : `Not saved — ${error.code}`}
          </p>
          <p className="mt-0.5 text-xs text-red-600">{error.message}</p>
        </div>
      ) : null}
      <ul className="divide-y divide-zinc-100">
        {rows.map((f) => {
          const conf = confidencePercent(f.confidence);
          const low = isLowConfidence(f.confidence);
          const editing = editingId === f.id;
          return (
            <li
              key={f.id}
              className={`${rowBase} ${low && f.status === "AI_DRAFT" ? "border-l-2 border-l-amber-400" : "border-l-2 border-l-transparent"}`}
            >
              <div className="w-52 shrink-0">
                <p className="font-medium text-zinc-900">
                  {fieldLabel(f.fieldKey)}
                  {requiredKeys.includes(f.fieldKey) ? <span className="ml-1 text-red-500">*</span> : null}
                </p>
                {f.sourcePage !== null ? <p className="text-[11px] text-zinc-400">page {f.sourcePage}</p> : null}
              </div>
              {editing ? (
                <div className="flex min-w-0 flex-1 flex-col gap-2">
                  <input
                    type="text"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") save(f);
                      if (e.key === "Escape") setEditingId(null);
                    }}
                    className="block w-full rounded-md border border-zinc-300 px-2.5 py-1.5 text-sm text-zinc-900 focus:border-zinc-500 focus:outline-none"
                    aria-label={`Correct ${fieldLabel(f.fieldKey)}`}
                  />
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => save(f)}
                      disabled={busyId === f.id}
                      className="rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
                    >
                      {busyId === f.id ? "Saving…" : "Save correction"}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setEditingId(null);
                        setError(null);
                      }}
                      className="rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <p className="min-w-0 flex-1 font-mono text-[13px] text-zinc-900">{formatFieldValue(f)}</p>
                  <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                    {conf ? (
                      <span
                        className={`${chip} ${low ? "bg-amber-50 text-amber-700 ring-1 ring-inset ring-amber-200" : "bg-zinc-100 text-zinc-600"}`}
                        title={low ? "Low confidence — review against the document" : "AI confidence"}
                      >
                        {low ? `⚠ ${conf}` : conf}
                      </span>
                    ) : null}
                    <StatusChip status={f.status} />
                    {canCorrect ? (
                      <span className="flex gap-1.5">
                        {f.status === "AI_DRAFT" ? (
                          <button
                            type="button"
                            disabled={busyId === f.id}
                            onClick={() => void apply(f, {})} // no value ⇒ confirm-as-extracted (row 12)
                            className="rounded-md border border-zinc-200 bg-white px-2.5 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
                          >
                            Confirm
                          </button>
                        ) : null}
                        <button
                          type="button"
                          onClick={() => {
                            setEditingId(f.id);
                            setDraft(rawEditableValue(f));
                            setError(null);
                          }}
                          className="rounded-md border border-zinc-200 bg-white px-2.5 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
                        >
                          Correct
                        </button>
                      </span>
                    ) : null}
                  </div>
                </>
              )}
            </li>
          );
        })}
        {missingRequired.map((k) => (
          <li key={k} className="flex flex-wrap items-baseline gap-x-3 border-l-2 border-l-red-400 bg-red-50/40 px-4 py-2.5 text-sm">
            <div className="w-52 shrink-0">
              <p className="font-medium text-zinc-900">
                {fieldLabel(k)}
                <span className="ml-1 text-red-500">*</span>
              </p>
            </div>
            <p className="min-w-0 flex-1 text-[13px] text-red-600">Required — not extracted. Use manual entry below.</p>
          </li>
        ))}
      </ul>
      {rows.some((f) => requiredKeys.includes(f.fieldKey)) || missingRequired.length > 0 ? (
        <p className="border-t border-zinc-100 px-4 py-2 text-[11px] text-zinc-400">
          <span className="text-red-500">*</span> required for export layout
        </p>
      ) : null}
    </div>
  );
}

/** Merges a PATCH response row (raw JSON, Decimals-as-strings) into the panel's shape. */
function toUpdated(raw: Record<string, unknown>, prior: ReviewField): Partial<ReviewField> {
  return {
    text: (raw.valueText as string | null) ?? null,
    numeric: (raw.valueNumeric as string | null) ?? null,
    date: (raw.valueDate as string | null) ?? null,
    currency: (raw.currency as string | null) ?? prior.currency,
    status: String(raw.status ?? prior.status),
  };
}
