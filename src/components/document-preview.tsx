"use client";

/**
 * Secure document preview (P4.4, PRD screen 4's left pane). Follows the row-11
 * chain IN THE BROWSER: fetch (same-origin, session cookie) → the route's 302
 * to a freshly minted 5-minute signed token → bytes.
 *
 * Why fetch instead of <iframe src="/api/documents/:id/file">: the iframe can
 * only render whatever the server returns — a 404/403/500 JSON envelope would
 * show as raw JSON, and expired/missing access would be invisible to the UI.
 * With fetch every failure mode is a REAL state the component can act on:
 *  - 403 → the capability was rejected → Retry mints a fresh token (the
 *    "document pane renews when expired" behavior row 11 promises);
 *  - 404 → document gone; 500 → storage integrity failure — both honest
 *    error panels with retry, never a fabricated preview;
 *  - unsupported MIME → usable fallback + open-in-tab (the signed chain still
 *    works there).
 *
 * Rendering is blob-URL-only: no innerHTML, no server HTML fragments, nothing
 * public — the blob URL dies with the page. PDFs render in the browser's own
 * viewer via <iframe>; images via <img>; everything else via the fallback.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { parseEnvelope } from "@/lib/envelope";

type PreviewState =
  | { phase: "loading" }
  | { phase: "ready"; url: string; mime: string }
  | { phase: "unsupported"; mime: string }
  | { phase: "error"; title: string; detail: string };

export function DocumentPreview({ documentId, fileName }: { documentId: string; fileName: string }) {
  const [state, setState] = useState<PreviewState>({ phase: "loading" });
  const urlRef = useRef<string | null>(null);

  const revoke = useCallback(() => {
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    }
  }, []);

  const load = useCallback(async () => {
    revoke();
    setState({ phase: "loading" });
    try {
      const res = await fetch(`/api/documents/${documentId}/file`, { credentials: "same-origin" });
      if (!res.ok || !res.body) {
        const parsed = await parseEnvelope<unknown>(res);
        const title =
          res.status === 403
            ? "Access expired"
            : res.status === 404
              ? "Document not found"
              : "Preview unavailable";
        setState({
          phase: "error",
          title,
          detail: parsed.ok ? "The server rejected this preview." : parsed.error.message,
        });
        return;
      }
      const mime = res.headers.get("content-type") ?? "application/octet-stream";
      if (!(mime === "application/pdf" || mime.startsWith("image/"))) {
        setState({ phase: "unsupported", mime });
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      urlRef.current = url;
      setState({ phase: "ready", url, mime });
    } catch {
      setState({ phase: "error", title: "Could not load preview", detail: "Check your connection and try again." });
    }
  }, [documentId, revoke]);

  useEffect(() => {
    void load();
    return revoke; // blob URLs die with this component — never leak, never persist
  }, [load, revoke]);

  return (
    <div className="flex h-full flex-col rounded-lg border border-zinc-200 bg-white">
      <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-2.5">
        <p className="truncate text-sm font-medium text-zinc-900" title={fileName}>
          {fileName}
        </p>
        <div className="flex shrink-0 items-center gap-2">
          {state.phase === "error" ? (
            <button
              type="button"
              onClick={() => void load()}
              className="rounded-md border border-zinc-200 bg-white px-2.5 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
            >
              Retry
            </button>
          ) : null}
          <a
            href={`/api/documents/${documentId}/file`}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-md border border-zinc-200 bg-white px-2.5 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
          >
            Open in new tab
          </a>
        </div>
      </div>
      <div className="min-h-[420px] flex-1">
        {state.phase === "loading" ? (
          <div className="flex h-full min-h-[420px] items-center justify-center text-sm text-zinc-500">
            Loading secure preview…
          </div>
        ) : null}
        {state.phase === "ready" && state.mime === "application/pdf" ? (
          <iframe src={state.url} title={`Preview of ${fileName}`} className="h-[560px] w-full rounded-b-lg" />
        ) : null}
        {state.phase === "ready" && state.mime.startsWith("image/") ? (
          // eslint-disable-next-line @next/next/no-img-element -- user's own uploaded file via a session-gated blob URL
          <img src={state.url} alt={`Preview of ${fileName}`} className="mx-auto max-h-[560px] w-full object-contain" />
        ) : null}
        {state.phase === "unsupported" ? (
          <div className="flex h-full min-h-[420px] flex-col items-center justify-center gap-1 px-6 text-center">
            <p className="text-sm font-medium text-zinc-900">No inline preview for {state.mime}</p>
            <p className="text-xs text-zinc-500">Use “Open in new tab” — the same secure, expiring access.</p>
          </div>
        ) : null}
        {state.phase === "error" ? (
          <div className="flex h-full min-h-[420px] flex-col items-center justify-center gap-1 px-6 text-center">
            <p className="text-sm font-medium text-red-700">{state.title}</p>
            <p className="text-xs text-zinc-500">{state.detail}</p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
