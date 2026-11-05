"use client";

/**
 * New-shipment modal (PRD screen 3, plan D-2): ref is auto-generated
 * server-side; supplier is free-text name + optional 2-letter country (the
 * 19-endpoint contract has no supplier-list endpoint to pick from).
 *
 * Validation REUSES the server's own Zod contract (`CreateShipmentDto`) —
 * one source of truth for shape, so client and API can never disagree.
 * Duplicate submissions are prevented two ways: the submit button disables
 * while pending, and a synchronous in-flight ref guard stops double-fires
 * that beat the state update. Success navigates to the created shipment.
 */
import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";
import { CreateShipmentDto } from "@/server/dto";
import { parseEnvelope } from "@/lib/envelope";
import { ErrorBanner } from "@/components/states";

export function NewShipmentButton({ label = "New shipment" }: { label?: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [supplierName, setSupplierName] = useState("");
  const [supplierCountry, setSupplierCountry] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<{ code?: string; message: string } | null>(null);
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);

  function close() {
    setOpen(false);
    setSupplierName("");
    setSupplierCountry("");
    setFieldErrors({});
    setFormError(null);
    inFlight.current = false;
    setPending(false);
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (inFlight.current) return; // double-click / Enter replay can't fire twice
    setFormError(null);
    setFieldErrors({});

    const payload = {
      ...(supplierName.trim() !== "" ? { supplierName: supplierName.trim() } : {}),
      ...(supplierCountry.trim() !== "" ? { supplierCountry: supplierCountry.trim() } : {}),
    };
    const parsed = CreateShipmentDto.safeParse(payload);
    if (!parsed.success) {
      const errs: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        errs[String(issue.path[0] ?? "form")] = issue.message;
      }
      setFieldErrors(errs);
      return;
    }

    inFlight.current = true;
    setPending(true);
    try {
      const res = await fetch("/api/shipments", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(parsed.data),
      });
      const envelope = await parseEnvelope<{ shipment: { id: string; ref: string } }>(res);
      if (!envelope.ok) {
        // Surface the API's own validation details per field when present.
        const details = envelope.error.details as { issues?: Array<{ path: string[]; message: string }> } | undefined;
        if (details?.issues?.length) {
          const errs: Record<string, string> = {};
          for (const issue of details.issues) errs[String(issue.path[0] ?? "form")] = issue.message;
          setFieldErrors(errs);
        }
        setFormError({ code: envelope.error.code, message: envelope.error.message });
        return;
      }
      router.push(`/shipments/${envelope.data.shipment.id}`);
      router.refresh();
    } catch {
      setFormError({ code: "NETWORK", message: "Could not reach the server. Try again." });
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  const inputClass =
    "mt-1 block w-full rounded-md border border-zinc-300 px-3 py-2 text-sm text-zinc-900 placeholder-zinc-400 focus:border-zinc-900 focus:outline-none focus:ring-1 focus:ring-zinc-900";
  const errClass = "mt-1 text-xs text-red-600";

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-800"
      >
        {label}
      </button>
      {open ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-900/30 p-4"
          role="dialog"
          aria-modal="true"
          aria-label="New shipment"
          onClick={(e) => {
            if (e.target === e.currentTarget) close();
          }}
        >
          <div className="w-full max-w-md rounded-lg border border-zinc-200 bg-white p-6 shadow-lg">
            <h2 className="text-base font-semibold tracking-tight text-zinc-900">New shipment</h2>
            <p className="mt-1 text-sm text-zinc-500">
              A reference is generated automatically. Supplier is optional.
            </p>
            <form onSubmit={onSubmit} noValidate className="mt-4 space-y-4">
              {formError ? <ErrorBanner code={formError.code} message={formError.message} /> : null}
              <div>
                <label htmlFor="supplierName" className="block text-sm font-medium text-zinc-700">
                  Supplier name
                </label>
                <input
                  id="supplierName"
                  type="text"
                  autoFocus
                  maxLength={120}
                  value={supplierName}
                  onChange={(e) => setSupplierName(e.target.value)}
                  className={inputClass}
                  placeholder="e.g. Global Textiles Pvt Ltd"
                />
                {fieldErrors.supplierName ? <p className={errClass}>{fieldErrors.supplierName}</p> : null}
              </div>
              <div>
                <label htmlFor="supplierCountry" className="block text-sm font-medium text-zinc-700">
                  Supplier country (optional, 2 letters)
                </label>
                <input
                  id="supplierCountry"
                  type="text"
                  maxLength={2}
                  value={supplierCountry}
                  onChange={(e) => setSupplierCountry(e.target.value)}
                  className={inputClass}
                  placeholder="e.g. CN"
                />
                {fieldErrors.supplierCountry ? <p className={errClass}>{fieldErrors.supplierCountry}</p> : null}
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={close}
                  className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={pending}
                  className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {pending ? "Creating…" : "Create shipment"}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </>
  );
}
