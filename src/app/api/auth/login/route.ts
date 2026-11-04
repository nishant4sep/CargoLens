/**
 * Contract row 1 — POST /api/auth/login.
 *
 * better-auth owns credentials, sessions, AND the session cookie's exact wire
 * format (a signed `token.signature` value — a raw token is refused by
 * `getSession`), so this route NEVER builds the cookie itself: it delegates to
 * the library with `asResponse: true` and forwards its set-cookie headers
 * verbatim. The response body is OUR shape ({user: {id, name, role}} — no
 * email/auth metadata).
 */
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { LoginDto } from "@/server/dto";
import { ApiError, readJson, toErrorResponse } from "@/server/http";

export async function POST(req: Request) {
  try {
    const parsed = LoginDto.safeParse(await readJson(req));
    if (!parsed.success) throw new ApiError("VALIDATION_ERROR", "Invalid login body");

    const libRes = await auth.api.signInEmail({ body: parsed.data, asResponse: true });
    const data = (await libRes.json()) as { user?: { id: string; name: string; role?: string } };
    const u = data?.user;
    if (!libRes.ok || !u) throw new ApiError("UNAUTHENTICATED", "Invalid email or password");

    const out = NextResponse.json({ user: { id: u.id, name: u.name, role: u.role } });
    for (const c of libRes.headers.getSetCookie()) out.headers.append("set-cookie", c);
    return out;
  } catch (e) {
    return toErrorResponse(e);
  }
}
