/**
 * Session resolution for Server Components (P4.1). Same library call as the
 * route guard — the ONLY difference is the cookie source: `headers()` from
 * next/headers instead of a Request. Kept in its own file because importing
 * `next/headers` is only legal inside a request render, and http.ts is
 * imported by test suites that must stay importable outside Next.
 */
import { headers } from "next/headers";
import { getSessionUserFromHeaders, type AuthUser } from "@/server/http";

/** Returns the signed-in user, or null — layouts decide redirect vs render. */
export async function getSessionUserRsc(): Promise<AuthUser | null> {
  return getSessionUserFromHeaders(await headers());
}
