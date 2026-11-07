"use client";

/**
 * Upload panel (PRD screen 4's document slots, plan P4.3): one slot per
 * required document type, fed by the REAL row-8 multipart endpoint.
 *
 * Safety mapping (06 §1.3 / the route's own contract):
 *  - client-side size/emptiness pre-check BEFORE any network (actionable, instant);
 *  - file TYPE is validated by the server's magic-byte sniff — the browser's
 *    MIME claim and the extension are advisory, so `accept` is a convenience
 *    filter only and a lying file gets the server's 400 verbatim;
 *  - upload progress: fetch() cannot report upload progress, so this uses the
 *    dependency-free standard (XMLHttpRequest upload.onprogress);
 *  - duplicate submissions: two layers — the button disables while pending
 *    AND a synchronous per-slot in-flight guard is checked before send
 *    (React state updates are async; two rapid clicks can both observe
 *    pending === false);
 *  - failure keeps the selected file in state so Retry re-fires it;
 *  - success calls router.refresh() — the server component re-renders with
 *    the new document row (server truth replaces local optimism).
 */
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { documentStatusLabel, formatBytes } from "@/lib/format";

export interface ExistingDoc {
  id: string;
  type: string;
  status: string;
  fileName: string;
  mimeType: string;
  sizeBytes: string;
  pageCount: number | null;
  extractedAt: string | null;
  extractError?: string | null; // WHY extraction failed (Phase 5) — absent in pre-Phase-5 payloads
}

const MAX_BYTES = 10 * 1024 * 1024; // mirrors the route's contract (413 beyond)

const TYPES = [
  { type: "INVOICE", label: "Invoice" },
  { type: "PACKING_LIST", label: "Packing list" },
  { type: "BILL_OF_LADING", label: "Bill of lading" },
] as const;

type SlotPhase =
  | { phase: "idle" }
  | { phase: "uploading"; pct: number }
  | { phase: "error"; message: string; code?: string };

export function DocumentUpload({ shipmentId, documents }: { shipmentId: string; documents: ExistingDoc[] }) {
  const router = useRouter();
  const [slots, setSlots] = useState<Record<string, SlotPhase>>({});
  const [files, setFiles] = useState<Record<string, File | null>>({});
  const inFlight = useRef(new Set<string>()); // synchronous duplicate-submit guard

  function setSlot(type: string, s: SlotPhase) {
    setSlots((prev) => ({ ...prev, [type]: s }));
  }

  function pick(type: string, file: File | null) {
    setFiles((prev) => ({ ...prev, [type]: file }));
    setSlot(type, { phase: "idle" }); // picking again clears a previous error
  }

  function upload(type: string) {
    const file = files[type];
    if (!file || inFlight.current.has(type)) return;
    if (file.size === 0) {
      setSlot(type, { phase: "error", message: "File is empty.", code: "VALIDATION_ERROR" });
      return;
    }
    if (file.size > MAX_BYTES) {
      setSlot(type, {
        phase: "error",
        message: `File is ${formatBytes(file.size)} — the limit is 10 MB. Choose a smaller file.`,
        code: "VALIDATION_ERROR",
      });
      return; // nothing was sent — 0 network, instant feedback
    }

    inFlight.current.add(type);
    setSlot(type, { phase: "uploading", pct: 0 });

    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/shipments/${shipmentId}/documents`);
    xhr.timeout = 60_000;
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) setSlot(type, { phase: "uploading", pct: Math.round((e.loaded / e.total) * 100) });
    };
    const settle = (s: SlotPhase) => {
      inFlight.current.delete(type);
      setSlot(type, s);
    };
    xhr.onload = () => {
      try {
        const body = JSON.parse(xhr.responseText) as { document?: ExistingDoc; error?: { code: string; message: string } };
        if (xhr.status === 201) {
          setFiles((prev) => ({ ...prev, [type]: null }));
          settle({ phase: "idle" });
          router.refresh(); // the server re-render replaces this slot's data
        } else {
          settle({ phase: "error", message: body.error?.message ?? "Upload failed.", code: body.error?.code });
        }
      } catch {
        settle({ phase: "error", message: "Unexpected server response.", code: "INTERNAL" });
      }
    };
    xhr.onerror = () => settle({ phase: "error", message: "Could not reach the server. Try again.", code: "NETWORK" });
    xhr.ontimeout = () => settle({ phase: "error", message: "Upload timed out. Try again.", code: "NETWORK" });

    const form = new FormData();
    form.set("type", type);
    form.set("file", file);
    xhr.send(form);
  }

  const inputClass =
    "block w-full rounded-md border border-zinc-300 text-sm text-zinc-900 file:mr-3 file:cursor-pointer file:rounded-l-md file:border-0 file:bg-zinc-100 file:px-3 file:py-2 file:text-sm file:font-medium file:text-zinc-700 hover:file:bg-zinc-200";
  const btnClass =
    "rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50";

  return (
    <div className="rounded-lg border border-zinc-200 bg-white">
      <div className="border-b border-zinc-200 px-4 py-3">
        <h2 className="text-sm font-semibold text-zinc-900">Documents</h2>
        <p className="mt-0.5 text-xs text-zinc-500">
          PDF, JPEG or PNG up to 10 MB — verified by file content, not file name. One file per type.
        </p>
      </div>
      <ul className="divide-y divide-zinc-100">
        {TYPES.map(({ type, label }) => {
          const existing = documents.find((d) => d.type === type);
          const slot = slots[type] ?? { phase: "idle" as const };
          const file = files[type] ?? null;
          const busy = slot.phase === "uploading";
          return (
            <li key={type} className="px-4 py-3">
              {existing ? (
                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-zinc-900">
                      {label} <span className="font-normal text-zinc-400">·</span>{" "}
                      <span className="font-normal text-zinc-600">{existing.fileName}</span>
                    </p>
                    <p className="mt-0.5 text-xs text-zinc-500">
                      {formatBytes(Number(existing.sizeBytes))} · {documentStatusLabel(existing.status)}
                    </p>
                  </div>
                  <a
                    href={`/api/documents/${existing.id}/file`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="shrink-0 rounded-md border border-zinc-200 bg-white px-2.5 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
                  >
                    View
                  </a>
                </div>
              ) : (
                <div className="space-y-2">
                  <p className="text-sm font-medium text-zinc-900">
                    {label} <span className="font-normal text-zinc-400">· not uploaded</span>
                  </p>
                  <div className="flex items-center gap-2">
                    <input
                      type="file"
                      accept=".pdf,.jpg,.jpeg,.png"
                      disabled={busy}
                      onChange={(e) => pick(type, e.target.files?.[0] ?? null)}
                      className={inputClass}
                      aria-label={`${label} file`}
                    />
                    <button
                      type="button"
                      onClick={() => upload(type)}
                      disabled={busy || !file}
                      className={btnClass}
                    >
                      {busy ? `Uploading… ${slot.pct}%` : file ? "Upload" : "Choose a file"}
                    </button>
                  </div>
                  {busy ? (
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-100" role="progressbar" aria-valuenow={slot.pct}>
                      <div className="h-full bg-zinc-900 transition-all" style={{ width: `${slot.pct}%` }} />
                    </div>
                  ) : null}
                  {slot.phase === "error" ? (
                    <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2">
                      <p className="text-xs font-medium text-red-700">
                        Upload failed{slot.code ? ` — ${slot.code}` : ""}
                      </p>
                      <p className="mt-0.5 text-xs text-red-600">{slot.message}</p>
                      <p className="mt-0.5 text-xs text-red-500">
                        {file ? "Fix the issue and upload again — your file is still selected." : "Select a file to retry."}
                      </p>
                    </div>
                  ) : null}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
