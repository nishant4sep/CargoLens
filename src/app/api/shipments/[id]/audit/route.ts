/** Contract row 18 — GET /api/shipments/:id/audit — the append-only ledger, newest first. */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ApiError, getSessionUser, toErrorResponse } from "@/server/http";
import { requireShipment } from "@/server/services/shipments";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, ctx: Ctx) {
  try {
    if (!(await getSessionUser(req))) throw new ApiError("UNAUTHENTICATED", "Sign in required");
    const { id } = await ctx.params;
    await requireShipment(id);
    const events = await prisma.auditEvent.findMany({
      where: { shipmentId: id },
      orderBy: { createdAt: "desc" },
      select: { id: true, action: true, actorId: true, actorName: true, payload: true, createdAt: true },
    });
    return NextResponse.json({ events });
  } catch (e) {
    return toErrorResponse(e);
  }
}
