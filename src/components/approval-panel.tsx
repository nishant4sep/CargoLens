"use client";

/**
 * Manager approval panel (P4.5, contract row 14 — POST /api/shipments/:id/approve).
 *
 * The readiness summary is a HUMAN display of the row-6 aggregate (outstanding
 * required fields from the engine's own seam, unresolved blocking checks,
 * corrections, accepted-with-note resolutions) — it is NOT a second gate: the
 * button renders only when the pure canApprove() helper says the machine's
 * APPROVE transition + the route's MANAGER requirement would both pass, and
 * even then the SERVER may still 409 (data changed between render and click).
 * Errors render verbatim, including the 409's missingCriteria JSON.
 */
import { useRouter } from "next/navigation";
import { useState } from "react";
import { parseEnvelope } from "@/lib/envelope";
import { ErrorBanner } from "@/components/states";
import { canApprove, checkTitle, fieldLabel, type ApprovalReadiness, type ViewerRole } from "@/lib/review";
import { documentTypeLabel } from "@/lib/format";

interface ApprovalInfo {
  approvedByName: string | null;
  approvedAt: string | null;
}

export function ApprovalPanel({
  shipmentId,
  status,
  role,
  approval,
  readiness,
}: {
  shipmentId: string;
  status: string;
  role: ViewerRole;
  approval: ApprovalInfo | null;
  readiness: ApprovalReadiness;
}) {
  const router = useRouter();
  const [error, setError] = useState<{ code?: string; message: string; details?: unknown } | null>(null);
  const [pending, setPending] = useState(false);
  const allowed = canApprove(status, role);

  async function approve() {
    setPending(true);
    setError(null);
    try {
      const res = await fetch(`/api/shipments/${shipmentId}/approve`, {
        method: "POST",
        credentials: "same-origin",
      });
      const envelope = await parseEnvelope(res);
      if (!envelope.ok) {
        setError({ code: envelope.error.code, message: envelope.error.message, details: envelope.error.details });
        return;
      }
      router.refresh(); // server re-render: APPROVED chip, actor, timestamp
    } catch {
      setError({ code: "NETWORK", message: "Could not reach the server. Try again." });
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="rounded-lg border border-zinc-200 bg-white" aria-label="Manager approval">
      <div className="border-b border-zinc-200 px-4 py-3">
        <h2 className="text-sm font-semibold text-zinc-900">Manager approval</h2>
        <p className="mt-0.5 text-xs text-zinc-500">
          The server's state machine decides — this panel only mirrors its criteria and never bypasses a 409.
        </p>
      </div>

      <div className="space-y-2 px-4 py-3 text-sm">
        <ReadyRow
          ok={readiness.blocking.length === 0}
          label="Blocking discrepancies"
          value={
            readiness.blocking.length === 0
              ? "None unresolved"
              : readiness.blocking.map((k) => checkTitle(k)).join("; ")
          }
        />
        <ReadyRow
          ok={readiness.outstanding.length === 0}
          label="Outstanding required fields"
          value={
            readiness.outstanding.length === 0
              ? "All human-cleared"
              : readiness.outstanding
                  .slice(0, 6)
                  .map((o) => `${fieldLabel(o.fieldKey)} · ${documentTypeLabel(o.docType)}`)
                  .concat(readiness.outstanding.length > 6 ? [`+${readiness.outstanding.length - 6} more`] : [])
                  .join("; ")
          }
        />
        <ReadyRow
          ok
          plain
          label="Corrections / resolutions"
          value={`${readiness.corrections} corrected field${readiness.corrections === 1 ? "" : "s"} · ${readiness.resolutions} accepted with note`}
        />
        <ReadyRow
          ok
          plain
          label="Approval"
          value={approval?.approvedAt ? `${approval.approvedByName ?? "manager"} · ${new Date(approval.approvedAt).toLocaleString("en-GB", { timeZone: "Asia/Kolkata", hour12: false })} IST` : "Not approved"}
        />
      </div>

      {error ? (
        <div className="px-4 pb-3">
          <ErrorBanner code={error.code} message={error.message} details={error.details} />
        </div>
      ) : null}

      <div className="px-4 pb-4">
        {allowed ? (
          <button
            type="button"
            onClick={approve}
            disabled={pending}
            className="rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {pending ? "Approving…" : "Approve shipment"}
          </button>
        ) : role === "MANAGER" ? (
          <p className="text-xs text-zinc-500">
            Approval unlocks when the shipment reaches <strong>Ready for approval</strong> — correct or resolve the
            items above until the machine lifts it.
          </p>
        ) : (
          <p className="text-xs text-zinc-500">
            Requires a manager sign-in — the approve route returns 403 for executives, so the button is not offered.
          </p>
        )}
      </div>
    </section>
  );
}

function ReadyRow({ ok, plain = false, label, value }: { ok: boolean; plain?: boolean; label: string; value: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-dashed border-zinc-100 pb-1.5 last:border-0">
      <span className="text-zinc-500">{label}</span>
      <span className={`max-w-[60%] text-right ${plain ? "text-zinc-700" : ok ? "text-emerald-700" : "font-medium text-red-600"}`}>
        {value}
      </span>
    </div>
  );
}
