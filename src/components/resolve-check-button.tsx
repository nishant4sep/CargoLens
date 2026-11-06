"use client";

/**
 * Accept-with-note control for an unresolved BLOCKING FAIL check (row 13).
 * The note is MANDATORY (ResolveCheckDto: min 1) — an executive cannot click
 * a discrepancy away silently. The server re-runs the invariants after the
 * write; router.refresh() pulls the new state. Errors render verbatim.
 */
import { useRouter } from "next/navigation";
import { useState } from "react";
import { parseEnvelope } from "@/lib/envelope";
import { ResolveCheckDto } from "@/server/dto";

export function ResolveCheckButton({ shipmentId, checkId, ruleKey }: { shipmentId: string; checkId: string; ruleKey: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    const check = ResolveCheckDto.safeParse({ note: note.trim() });
    if (!check.success) {
      setError("A resolution note is required (max 500 characters).");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/shipments/${shipmentId}/checks/${checkId}/resolve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(check.data),
      });
      const parsed = await parseEnvelope<unknown>(res);
      if (!parsed.ok) {
        setError(parsed.error.message);
        return;
      }
      setOpen(false);
      setNote("");
      router.refresh();
    } catch {
      setError("Could not reach the server. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="shrink-0">
      {!open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label={`Resolve ${ruleKey}`}
          className="rounded-md border border-red-200 bg-white px-2.5 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50"
        >
          Resolve…
        </button>
      ) : (
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submit();
              if (e.key === "Escape") setOpen(false);
            }}
            placeholder="Why is this discrepancy accepted?"
            aria-label={`Resolution note for ${ruleKey}`}
            className="block w-72 rounded-md border border-zinc-300 px-2.5 py-1.5 text-sm focus:border-zinc-500 focus:outline-none"
          />
          <button
            type="button"
            onClick={() => void submit()}
            disabled={busy}
            className="rounded-md bg-zinc-900 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
          >
            {busy ? "Saving…" : "Record resolution"}
          </button>
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              setError(null);
            }}
            className="rounded-md border border-zinc-200 bg-white px-2.5 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
          >
            Cancel
          </button>
        </div>
      )}
      {error ? <p className="mt-1 text-xs text-red-600">{error}</p> : null}
    </div>
  );
}
