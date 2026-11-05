/**
 * API plumbing (file 04 §4 contract): the ONE place that knows the error
 * envelope, the auth guard, and exception→response mapping. Routes stay thin
 * (parse → guard → service → json); services throw ApiError and never learn
 * about HTTP.
 *
 * Error envelope: { "error": { "code", "message", "details"? } } — codes are
 * the contract's fixed set (VALIDATION_ERROR/UNAUTHENTICATED/FORBIDDEN/
 * NOT_FOUND/CONFLICT/UNPROCESSABLE/RATE_LIMITED/INTERNAL).
 *
 * Secrets discipline: this layer never logs request bodies; unexpected errors
 * log ONLY a short message server-side and return an opaque INTERNAL body —
 * no stack traces, no Prisma internals, no auth material.
 */
import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { Prisma } from "@prisma/client";
import { auth } from "@/lib/auth";

export type ApiErrorCode =
  | "VALIDATION_ERROR"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "UNPROCESSABLE"
  | "RATE_LIMITED"
  | "INTERNAL";

const STATUS: Record<ApiErrorCode, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  UNPROCESSABLE: 422,
  RATE_LIMITED: 429,
  INTERNAL: 500,
};

/** better-auth's session cookie (library default name — we must match it). */
export const SESSION_COOKIE = "better-auth.session_token";

/** Services throw this; `toErrorResponse` translates it to the contract envelope.
 *  `statusOverride` is for the rare status a code doesn't pin (e.g. 413 with the
 *  VALIDATION_ERROR code — the code set stays at 8, the HTTP status stays precise). */
export class ApiError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly details?: unknown,
    readonly statusOverride?: number,
  ) {
    super(message);
  }
}

export function toErrorResponse(e: unknown): NextResponse {
  if (e instanceof ApiError) {
    return NextResponse.json(
      {
        error: {
          code: e.code,
          message: e.message,
          ...(e.details !== undefined ? { details: e.details } : {}),
        },
      },
      { status: e.statusOverride ?? STATUS[e.code] },
    );
  }
  if (e instanceof ZodError) {
    return NextResponse.json(
      {
        error: {
          code: "VALIDATION_ERROR",
          message: "Invalid request",
          details: { issues: e.issues.map((i) => ({ path: i.path.join("."), message: i.message })) },
        },
      },
      { status: 400 },
    );
  }
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
    // Unique-constraint races surface as the contract's CONFLICT (e.g. duplicate
    // shipment ref retry exhausted) — the DB is the last line of defense.
    return NextResponse.json(
      { error: { code: "CONFLICT", message: "Resource already exists" } },
      { status: 409 },
    );
  }
  if (e instanceof Error && typeof (e as { statusCode?: unknown }).statusCode === "number") {
    // better-auth's own APIError (bad credentials etc.). NOTE: deliberately
    // DUCK-TYPED, not `instanceof APIError` — the better-auth/api subpath
    // resolves to a different module instance than the error's constructor
    // (dual-package hazard), so instanceof is false even for real APIErrors.
    // Verified empirically (scripts probe, 2026-11-04): thrown value carries
    // statusCode: 401 (number), status: 'UNAUTHORIZED' (string keyword),
    // body.code: 'INVALID_EMAIL_OR_PASSWORD'. Map the numeric status → the
    // contract's code set; the library's messages are client-safe.
    const byStatus: Record<number, ApiErrorCode> = {
      400: "VALIDATION_ERROR",
      401: "UNAUTHENTICATED",
      403: "FORBIDDEN",
      404: "NOT_FOUND",
      409: "CONFLICT",
      422: "UNPROCESSABLE",
      429: "RATE_LIMITED",
    };
    const status = (e as { statusCode?: number }).statusCode ?? 500;
    const code = byStatus[status] ?? "INTERNAL";
    return NextResponse.json(
      { error: { code, message: e.message || "Authentication error" } },
      { status: STATUS[code] },
    );
  }
  // Next's build-time prerender bail-out ("needs to bail out of prerendering
  // … used request.headers") surfaces here when `next build` dry-runs GET
  // route handlers. Expected by design (every endpoint is request-dependent);
  // NOT an incident, so don't mislabel it as an internal error.
  if (e instanceof Error && e.message.includes("bail out of prerendering")) {
    return NextResponse.json(
      { error: { code: "INTERNAL", message: "Unexpected server error" } },
      { status: 500 },
    );
  }
  // Server-side log keeps a short message only (no bodies, no stack dumps to clients).
  console.error("[api] internal error:", e instanceof Error ? e.message : String(e));
  return NextResponse.json(
    { error: { code: "INTERNAL", message: "Unexpected server error" } },
    { status: 500 },
  );
}

export type AuthUser = { id: string; name: string; email: string; role: "EXECUTIVE" | "MANAGER" };

/**
 * Server-side session resolution for EVERY protected route (file 04 §4:
 * "every mutating route re-checks auth server-side"). Reads the better-auth
 * cookie via the library's own server API — no homemade token parsing.
 *
 * The Headers-based core is the ONE implementation: routes pass `req.headers`,
 * Server Components pass `await headers()` (via @/server/session). The RSC
 * wrapper lives in its own file so test-importable modules never pull in
 * `next/headers` (which only works inside a request render).
 */
export async function getSessionUserFromHeaders(h: Headers): Promise<AuthUser | null> {
  const session = await auth.api.getSession({ headers: h });
  if (!session?.user) return null;
  return {
    id: session.user.id,
    name: session.user.name,
    email: session.user.email,
    role: session.user.role as AuthUser["role"],
  };
}

export async function getSessionUser(req: Request): Promise<AuthUser | null> {
  return getSessionUserFromHeaders(req.headers);
}

/** Body reader that never throws — malformed JSON becomes a Zod 400, not a 500. */
export async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}
