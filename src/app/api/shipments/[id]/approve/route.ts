/** Contract row 14 — POST /api/shipments/:id/approve — MANAGER only; 403 for executives. */
import { NextResponse } from "next/server";
import { ApiError, getSessionUser, toErrorResponse } from "@/server/http";
import { approveShipment } from "@/server/services/workflow";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, ctx: Ctx) {
  try {
    const user = await getSessionUser(req);
    if (!user) throw new ApiError("UNAUTHENTICATED", "Sign in required");
    if (user.role !== "MANAGER") throw new ApiError("FORBIDDEN", "Manager role required");
    const { id } = await ctx.params;
    return NextResponse.json({ shipment: await approveShipment(user, id) });
  } catch (e) {
    return toErrorResponse(e);
  }
}
