/** Contract row 15 — POST /api/shipments/:id/revoke — MANAGER only. */
import { NextResponse } from "next/server";
import { ApiError, getSessionUser, toErrorResponse } from "@/server/http";
import { revokeShipment } from "@/server/services/workflow";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, ctx: Ctx) {
  try {
    const user = await getSessionUser(req);
    if (!user) throw new ApiError("UNAUTHENTICATED", "Sign in required");
    if (user.role !== "MANAGER") throw new ApiError("FORBIDDEN", "Manager role required");
    const { id } = await ctx.params;
    return NextResponse.json({ shipment: await revokeShipment(user, id) });
  } catch (e) {
    return toErrorResponse(e);
  }
}
