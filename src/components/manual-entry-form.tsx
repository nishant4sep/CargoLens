"use client";

/**
 * Manual-entry form (P4.4, PRD screen 4's remediation path): for documents
 * whose extraction is missing, unreadable, failed, or unsupported — the human
 * supplies the values through the row-10 endpoint. D-1b semantics apply
 * server-side (DRAFT fires the machine's EXTRACTION_STARTED; PROCESSING-phase
 * entry IS the extraction), so this form NEVER synthesizes a state change —
 * it posts values and lets the service + machine decide.
 *
 * Discipline:
 *  - required fields come from the ENGINE's own REQUIRED_FIELD_KEYS export —
 *    the UI maintains no second copy of that policy;
 *  - values are validated with the SERVER'S OWN ManualEntryDto before submit;
 *    a 422 from parseCorrection is rendered verbatim (never silently
 *    converted);
 *  - inputs are CONTROLLED state — no per-render snapshots that lose edits;
 *  - saved values appear immediately (server truth after router.refresh());
 *  - partial completion is normal: only non-empty inputs are submitted, so an
 *    executive can complete a document across several passes;
 *  - unresolved blocking checks are NOT bypassable from here: they are
 *    re-derived server-side after every write and still gate approval.
 */
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { parseEnvelope } from "@/lib/envelope";
import { fieldLabel, rawEditableValue, type ReviewField } from "@/lib/review";
import { DOC_TYPES_REQUIRING_LINES, REQUIRED_FIELD_KEYS } from "@/server/engines/crosschecks";
import { FIELD_KEYS, type DocType, type FieldKey } from "@/lib/types";
import { ManualEntryDto } from "@/server/dto";

interface LineDraft {
  seq: number;
  description: string;
  quantity: string;
  unitPrice: string;
  hsnCode: string;
}

const input =
  "block w-full rounded-md border border-zinc-300 px-2.5 py-1.5 text-sm text-zinc-900 focus:border-zinc-500 focus:outline-none";

export function ManualEntryForm({
  shipmentId,
  documentId,
  docType,
  fields,
  enabled,
}: {
  shipmentId: string;
  documentId: string;
  docType: DocType;
  fields: ReviewField[];
  enabled: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [extraKey, setExtraKey] = useState<"" | FieldKey>("");
  const [extraValue, setExtraValue] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const [lines, setLines] = useState<LineDraft[]>([]);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<string[] | null>(null);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);

  const required = REQUIRED_FIELD_KEYS[docType];
  const byKey = new Map(fields.map((f) => [f.fieldKey, f]));
  const needsLines = (DOC_TYPES_REQUIRING_LINES as readonly string[]).includes(docType);

  // Re-sync controlled inputs from server truth whenever the fields change
  // (after a save + refresh the form shows exactly what the server stored).
  useEffect(() => {
    const next: Record<string, string> = {};
    for (const k of FIELD_KEYS) {
      const existing = byKey.get(k);
      next[k] = existing ? rawEditableValue(existing) : "";
    }
    setValues(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- byKey is a view over `fields`
  }, [fields]);

  if (!enabled) return null;

  function addLine() {
    setLines((prev) => [...prev, { seq: prev.length + 1, description: "", quantity: "", unitPrice: "", hsnCode: "" }]);
  }

  async function submit() {
    setError(null);
    setSaved(null);
    const payload = {
      fields: Object.entries(values)
        .filter(([k, v]) => v.trim() !== "" && (required.includes(k as FieldKey) || k === extraKey))
        .map(([k, v]) => ({ fieldKey: k as FieldKey, value: v.trim() })),
      lineItems: needsLines
        ? lines
            .filter((l) => l.description.trim() !== "" || l.quantity.trim() !== "")
            .map((l) => ({
              seq: l.seq,
              description: l.description.trim(),
              quantity: Number(l.quantity),
              unitPrice: l.unitPrice.trim() === "" ? undefined : Number(l.unitPrice),
              hsnCode: l.hsnCode.trim() === "" ? undefined : l.hsnCode.trim(),
            }))
        : undefined,
    };
    const check = ManualEntryDto.safeParse(payload);
    if (!check.success) {
      const first = check.error.issues[0];
      setError({
        code: "VALIDATION_ERROR",
        message: `${first.path.join(".")}: ${first.message}${first.message.includes("number") ? " — enter numbers without currency symbols" : ""}`,
      });
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/documents/${documentId}/manual`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(check.data),
      });
      const parsed = await parseEnvelope<{ written: string[] }>(res);
      if (!parsed.ok) {
        setError({ code: parsed.error.code, message: parsed.error.message }); // 422/409 verbatim
        return;
      }
      setSaved(parsed.data.written);
      setExtraKey("");
      setExtraValue("");
      setLines([]);
      router.refresh(); // shipment status / checks / doc status may all change
    } catch {
      setError({ code: "NETWORK", message: "Could not reach the server. Try again." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg border border-zinc-200 bg-white">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between px-4 py-3 text-left"
        aria-expanded={open}
      >
        <span>
          <span className="text-sm font-semibold text-zinc-900">Manual entry</span>
          <span className="ml-2 text-xs text-zinc-500">
            for fields the extraction missed, failed, or could not read — values are typed by kind (money, weight, date)
          </span>
        </span>
        <span className="text-xs font-medium text-zinc-500">{open ? "Hide" : "Open"}</span>
      </button>
      {open ? (
        <div className="space-y-4 border-t border-zinc-200 px-4 py-4">
          {error ? (
            <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2">
              <p className="text-xs font-medium text-red-700">Not saved — {error.code}</p>
              <p className="mt-0.5 text-xs text-red-600">{error.message}</p>
            </div>
          ) : null}
          {saved ? (
            <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2">
              <p className="text-xs font-medium text-emerald-700">Saved: {saved.map(fieldLabel).join(", ")}</p>
            </div>
          ) : null}

          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {required.map((k) => {
              const existing = byKey.get(k);
              return (
                <label key={k} className="block">
                  <span className="mb-1 block text-xs font-medium text-zinc-700">
                    {fieldLabel(k)} <span className="text-red-500">*</span>
                    {existing ? (
                      <span className="ml-1 font-normal text-zinc-400">· saved: {rawEditableValue(existing) || "unreadable"}</span>
                    ) : null}
                  </span>
                  <input
                    type="text"
                    value={values[k] ?? ""}
                    placeholder={`Enter ${fieldLabel(k).toLowerCase()}`}
                    className={input}
                    aria-label={`Manual entry: ${fieldLabel(k)}`}
                    onChange={(e) => setValues((prev) => ({ ...prev, [k]: e.target.value }))}
                  />
                </label>
              );
            })}
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-zinc-700">Add another field</span>
              <select
                value={extraKey}
                onChange={(e) => setExtraKey(e.target.value as "" | FieldKey)}
                className={input}
                aria-label="Additional field to enter"
              >
                <option value="">— choose —</option>
                {FIELD_KEYS.filter((k) => !required.includes(k)).map((k) => (
                  <option key={k} value={k}>
                    {fieldLabel(k)}
                  </option>
                ))}
              </select>
            </label>
            {extraKey ? (
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-zinc-700">{fieldLabel(extraKey)}</span>
                <input
                  type="text"
                  value={extraValue}
                  onChange={(e) => setExtraValue(e.target.value)}
                  className={input}
                  aria-label={`Manual entry: ${fieldLabel(extraKey)}`}
                />
              </label>
            ) : null}
          </div>

          {needsLines ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-xs font-medium text-zinc-700">
                  Line items <span className="text-red-500">*</span>
                  <span className="ml-1 font-normal text-zinc-400">· qty × unit price must equal the line total</span>
                </p>
                <button
                  type="button"
                  onClick={addLine}
                  className="rounded-md border border-zinc-200 bg-white px-2.5 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
                >
                  + Add line
                </button>
              </div>
              {lines.map((l) => (
                <div key={l.seq} className="grid grid-cols-12 items-center gap-2">
                  <input
                    type="text"
                    placeholder="Description"
                    aria-label={`Line ${l.seq} description`}
                    className={`${input} col-span-5`}
                    onChange={(e) => {
                      l.description = e.target.value;
                    }}
                  />
                  <input
                    type="text"
                    placeholder="Qty"
                    aria-label={`Line ${l.seq} quantity`}
                    className={`${input} col-span-2`}
                    onChange={(e) => {
                      l.quantity = e.target.value;
                    }}
                  />
                  <input
                    type="text"
                    placeholder="Unit price"
                    aria-label={`Line ${l.seq} unit price`}
                    className={`${input} col-span-2`}
                    onChange={(e) => {
                      l.unitPrice = e.target.value;
                    }}
                  />
                  <input
                    type="text"
                    placeholder="HSN (opt.)"
                    aria-label={`Line ${l.seq} HSN code`}
                    className={`${input} col-span-2`}
                    onChange={(e) => {
                      l.hsnCode = e.target.value;
                    }}
                  />
                  <button
                    type="button"
                    aria-label={`Remove line ${l.seq}`}
                    className="col-span-1 rounded-md border border-zinc-200 bg-white px-2 py-1.5 text-xs text-zinc-500 hover:bg-zinc-50"
                    onClick={() => setLines((prev) => prev.filter((x) => x.seq !== l.seq))}
                  >
                    ✕
                  </button>
                  <span className="col-span-12 -mt-1 text-[11px] text-zinc-400">line #{l.seq}</span>
                </div>
              ))}
            </div>
          ) : null}

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => void submit()}
              disabled={busy}
              className="rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? "Saving…" : "Save manual entries"}
            </button>
            <p className="text-xs text-zinc-500">
              Blank inputs are skipped — you can complete the document across several passes. Every write is audited and
              re-runs the deterministic checks.
            </p>
          </div>
        </div>
      ) : null}
    </div>
  );
}
