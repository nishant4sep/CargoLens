"use client";

/**
 * Accept-with-note control for an unresolved BLOCKING FAIL check (row 13).
 * The note is MANDATORY (ResolveCheckDto: min 1) — an executive cannot click
 * a discrepancy away silently. The server re-runs the invariants after the
 * write; router.refresh() pulls the new state. Errors render verbatim.
 *
 * Enhanced for Company A: includes a 1-click "WhatsApp Importer Query" generator
 * to streamline the senior doubt group workflow directly from the review workbench.
 */
import { useRouter } from "next/navigation";
import { useState } from "react";
import { parseEnvelope } from "@/lib/envelope";
import { ResolveCheckDto } from "@/server/dto";

export function ResolveCheckButton({
  shipmentId,
  checkId,
  ruleKey,
  shipmentRef,
  detailsText,
}: {
  shipmentId: string;
  checkId: string;
  ruleKey: string;
  shipmentRef?: string;
  detailsText?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // WhatsApp Query state
  const [showWhatsApp, setShowWhatsApp] = useState(false);
  const [copied, setCopied] = useState(false);

  const queryDraft = `*Customs Discrepancy Query — Ref: ${shipmentRef || "Shipment"}*
We detected a document discrepancy on *${ruleKey.replace(/_/g, " ")}*:
${detailsText || "Please review the discrepancies between your Commercial Invoice, Packing List, and Bill of Lading."}

Please confirm the correct particulars so our documentation team at Nhava Sheva can proceed with customs filing without demurrage delay.
— Documentation Team, Company A`;

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

  function copyQuery() {
    void navigator.clipboard.writeText(queryDraft).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    });
  }

  return (
    <div className="flex flex-col items-end gap-1.5 shrink-0">
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => setShowWhatsApp(!showWhatsApp)}
          title="Draft query for importer (WhatsApp group)"
          className="rounded-md border border-emerald-300 bg-emerald-50 px-2 py-1.5 text-xs font-medium text-emerald-800 hover:bg-emerald-100 transition-colors"
        >
          💬 WhatsApp Query
        </button>

        {!open ? (
          <button
            type="button"
            onClick={() => setOpen(true)}
            aria-label={`Resolve ${ruleKey}`}
            className="rounded-md border border-red-200 bg-white px-2.5 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50 transition-colors"
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
      </div>

      {showWhatsApp ? (
        <div className="w-80 rounded-lg border border-emerald-200 bg-emerald-50/70 p-2.5 text-xs text-emerald-950 shadow-sm">
          <div className="flex items-center justify-between pb-1.5 border-b border-emerald-200 mb-1.5">
            <span className="font-semibold text-emerald-900 flex items-center gap-1">
              📱 Importer Query Draft
            </span>
            <button
              type="button"
              onClick={() => setShowWhatsApp(false)}
              className="text-emerald-700 hover:text-emerald-900 text-xs"
            >
              ✕
            </button>
          </div>
          <p className="whitespace-pre-line font-mono text-[11px] bg-white p-2 rounded border border-emerald-200 text-zinc-800 select-all">
            {queryDraft}
          </p>
          <div className="mt-2 flex items-center justify-end gap-1.5">
            <button
              type="button"
              onClick={copyQuery}
              className="rounded border border-emerald-300 bg-white px-2 py-1 text-[11px] font-medium text-emerald-800 hover:bg-emerald-50"
            >
              {copied ? "✓ Copied!" : "Copy text"}
            </button>
            <a
              href={`https://api.whatsapp.com/send?text=${encodeURIComponent(queryDraft)}`}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded bg-emerald-700 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-emerald-800"
            >
              Open WhatsApp
            </a>
          </div>
        </div>
      ) : null}

      {error ? <p className="mt-1 text-xs text-red-600">{error}</p> : null}
    </div>
  );
}
