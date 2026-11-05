/**
 * The shared UI states kit (plan §9) — one restrained vocabulary for loading,
 * empty, error and success across every screen. Server-safe (no hooks); the
 * only interactive piece is an optional action node passed in by a client
 * parent. Styling: zinc neutrals, white surfaces, no color theater.
 */
import type { ReactNode } from "react";

/** Route-level skeleton (loading.tsx) — shimmer rows sized like a table/list. */
export function LoadingSkeleton({ rows = 4, label }: { rows?: number; label?: string }) {
  return (
    <div role="status" aria-label={label ?? "Loading"} className="space-y-2">
      {Array.from({ length: rows }, (_, i) => (
        <div
          key={i}
          className="h-10 animate-pulse rounded-md border border-zinc-100 bg-zinc-100"
          style={{ width: `${100 - ((i * 7) % 23)}%` }}
        />
      ))}
    </div>
  );
}

/** Empty state with an explicit next action — no dead ends (PRD rule). */
export function EmptyState({
  title,
  message,
  action,
}: {
  title: string;
  message: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-zinc-300 bg-white px-6 py-14 text-center">
      <p className="text-sm font-semibold text-zinc-900">{title}</p>
      <p className="mt-1 max-w-sm text-sm text-zinc-500">{message}</p>
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

/** Inline error banner — renders the API envelope's message/details verbatim. */
export function ErrorBanner({
  code,
  message,
  details,
}: {
  code?: string;
  message: string;
  details?: unknown;
}) {
  return (
    <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm">
      <p className="font-medium text-red-800">{message}</p>
      {code ? <p className="mt-0.5 font-mono text-xs text-red-600">{code}</p> : null}
      {details !== undefined ? (
        <pre className="mt-1 overflow-x-auto whitespace-pre-wrap font-mono text-xs text-red-700">
          {typeof details === "string" ? details : JSON.stringify(details)}
        </pre>
      ) : null}
    </div>
  );
}

/** Inline success note (e.g. export created: file name + sha256). */
export function SuccessNote({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div role="status" className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm">
      <p className="font-medium text-emerald-800">{title}</p>
      {children ? <div className="mt-0.5 text-emerald-700">{children}</div> : null}
    </div>
  );
}
