"use client";

/**
 * The explicit per-document "Extract with AI" action (Phase 5, contract row 9).
 *
 * POSTing /api/documents/:id/extract is the ONLY way AI extraction starts —
 * no background job, no automatic run on upload. States:
 *  - idle: the action label (Extract with AI / Re-run AI extraction);
 *  - busy: disabled with an honest label — a real provider run can take tens
 *    of seconds; the page's own PROCESSING banner explains the state;
 *  - error: the server's envelope rendered VERBATIM (503 provider-unavailable,
 *    409 in-flight/exported…) — the UI never paraphrases a refusal into success;
 *  - success: router.refresh() — fields, checks and metrics are re-rendered
 *    from the server aggregate, the same truth the integration tests assert.
 */
import { useRouter } from "next/navigation";
import { useState } from "react";
import { parseEnvelope } from "@/lib/envelope";

export function ExtractButton({ documentId, action }: { documentId: string; action: "extract" | "re-extract" }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/documents/${documentId}/extract`, {
        method: "POST",
        credentials: "same-origin",
      });
      const parsed = await parseEnvelope(res);
      if (!parsed.ok) {
        setError({ code: parsed.error.code, message: parsed.error.message });
        return;
      }
      router.refresh();
    } catch {
      setError({ code: "NETWORK", message: "Could not reach the server. Try again." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg border border-zinc-200 bg-white px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-semibold text-zinc-900">AI extraction</p>
          <p className="mt-0.5 text-xs text-zinc-500">
            Reads this document with the configured AI provider and drafts its fields for human review. Extracted
            values are drafts — nothing is approved, and your corrections are never overwritten.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void run()}
          disabled={busy}
          className="rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
        >
          {busy ? "Extracting…" : action === "extract" ? "Extract with AI" : "Re-run AI extraction"}
        </button>
      </div>
      {error ? (
        <div className="mt-2 rounded-md border border-red-200 bg-red-50 px-3 py-2">
          <p className="text-xs font-medium text-red-700">Extraction did not run — {error.code}</p>
          <p className="mt-0.5 text-xs text-red-600">{error.message}</p>
        </div>
      ) : null}
    </div>
  );
}
