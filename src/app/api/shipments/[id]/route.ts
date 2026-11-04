/** Contract rows 6–7 — GET /api/shipments/:id (full aggregate) · PATCH (link supplier). */
import { NextResponse } from "next/server";
import { PatchShipmentDto } from "@/server/dto";
import { ApiError, getSessionUser, readJson, toErrorResponse } from "@/server/http";
import { getShipmentDetail, patchShipment } from "@/server/services/shipments";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, ctx: Ctx) {
  try {
    if (!(await getSessionUser(req))) throw new ApiError("UNAUTHENTICATED", "Sign in required");
    const { id } = await ctx.params;
    const detail = await getShipmentDetail(id);
    if (!detail) throw new ApiError("NOT_FOUND", "Shipment not found", { shipmentId: id });
    return NextResponse.json(detail);
  } catch (e) {
    return toErrorResponse(e);
  }
}

export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const user = await getSessionUser(req);
    if (!user) throw new ApiError("UNAUTHENTICATED", "Sign in required");
    const { id } = await ctx.params;
    const parsed = PatchShipmentDto.safeParse(await readJson(req));
    if (!parsed.success) throw new ApiError("VALIDATION_ERROR", "Invalid body");
    return NextResponse.json({ shipment: await patchShipment(user, id, parsed.data) });
  } catch (e) {
    return toErrorResponse(e);
  }
}
