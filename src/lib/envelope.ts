/**
 * The ONE envelope parser for client-side fetches (P4.1). Mirrors the server's
 * `toErrorResponse` shape exactly: success is any 2xx JSON body; failure is
 * `{ error: { code, message, details? } }` — or, if something speaks
 * non-JSON (a proxy, a crash), an opaque INTERNAL with the HTTP status kept.
 * UI components render `error.message`/`error.details` and never guess.
 */

export interface ApiErrorInfo {
  code: string;
  message: string;
  details?: unknown;
}

export type EnvelopeResult<T> =
  | { ok: true; data: T; status: number }
  | { ok: false; error: ApiErrorInfo; status: number };

export async function parseEnvelope<T = unknown>(res: Response): Promise<EnvelopeResult<T>> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null; // empty or non-JSON body — fall through to the mapping below
  }

  if (!res.ok) {
    const err = (body as { error?: Partial<ApiErrorInfo> } | null)?.error;
    return {
      ok: false,
      status: res.status,
      error: {
        code: typeof err?.code === "string" ? err.code : "INTERNAL",
        message: typeof err?.message === "string" ? err.message : "Unexpected server error",
        ...(err?.details !== undefined ? { details: err.details } : {}),
      },
    };
  }

  return { ok: true, status: res.status, data: body as T };
}
