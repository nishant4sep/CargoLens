/** Contract row 3 — GET /api/auth/me: {id, name, role} — never returns email/auth metadata. */
import { NextResponse } from "next/server";
import { ApiError, getSessionUser, toErrorResponse } from "@/server/http";

export async function GET(req: Request) {
  try {
    const user = await getSessionUser(req);
    if (!user) throw new ApiError("UNAUTHENTICATED", "Sign in required");
    return NextResponse.json({ id: user.id, name: user.name, role: user.role });
  } catch (e) {
    return toErrorResponse(e);
  }
}
