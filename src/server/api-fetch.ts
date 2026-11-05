/**
 * The ONE server-side fetch helper for Server Components (plan §8, P4.2).
 * The API is a deliverable — UI reads/writes go through it over HTTP, never
 * around it via direct DB access, so the UI proves the contract works.
 *
 * Security properties:
 *  - the browser's cookie header is forwarded VERBATIM to our own API origin
 *    (server→self, HTTPS in prod); it is never logged, echoed, or stored;
 *  - failure logs keep the path + short message only — no cookies, no
 *    envelope internals, no stack traces to the client (they get the
 *    contract envelope's own message);
 *  - 10s timeout so a hung origin can never hang a render.
 *
 * The origin is derived from the incoming Host (+ x-forwarded-proto behind
 * a proxy); APP_ORIGIN overrides for non-standard local setups.
 */
import { headers } from "next/headers";
import { parseEnvelope } from "@/lib/envelope";

export type ApiFetchResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; error: { code: string; message: string; details?: unknown } };

function originFromHeaders(h: Readonly<Headers>): string {
  if (process.env.APP_ORIGIN) return process.env.APP_ORIGIN;
  const host = h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

export async function apiFetch<T>(path: string): Promise<ApiFetchResult<T>> {
  const h = await headers();
  try {
    const res = await fetch(`${originFromHeaders(h)}${path}`, {
      headers: {
        cookie: h.get("cookie") ?? "",
        accept: "application/json",
      },
      cache: "no-store", // live data; the API owns all caching semantics
      signal: AbortSignal.timeout(10_000),
    });
    const parsed = await parseEnvelope<T>(res);
    return parsed.ok
      ? { ok: true, data: parsed.data }
      : { ok: false, status: parsed.status, error: parsed.error };
  } catch (e) {
    // Network-level failure (origin down, timeout) — the envelope never made it.
    console.error(`[api-fetch] ${path} failed:`, e instanceof Error ? e.message : String(e));
    return {
      ok: false,
      status: 0,
      error: { code: "NETWORK", message: "Could not reach the API server. Try again." },
    };
  }
}
