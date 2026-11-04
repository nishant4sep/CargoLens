/** Contract row 2 — POST /api/auth/logout: destroys the session row + clears the cookie. */
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { ApiError, getSessionUser, SESSION_COOKIE, toErrorResponse } from "@/server/http";

export async function POST(req: Request) {
  try {
    const user = await getSessionUser(req);
    if (!user) throw new ApiError("UNAUTHENTICATED", "Sign in required");
    await auth.api.signOut({ headers: req.headers });
    const res = NextResponse.json({ ok: true });
    res.cookies.delete(SESSION_COOKIE);
    return res;
  } catch (e) {
    return toErrorResponse(e);
  }
}
