/** Contract rows 4–5 — GET /api/shipments (paginated list) · POST /api/shipments (create). */
import { NextResponse } from "next/server";
import { CreateShipmentDto, ListShipmentsDto } from "@/server/dto";
import { ApiError, getSessionUser, readJson, toErrorResponse } from "@/server/http";
import { createShipment, listShipments } from "@/server/services/shipments";

export async function GET(req: Request) {
  try {
    if (!(await getSessionUser(req))) throw new ApiError("UNAUTHENTICATED", "Sign in required");
    const url = new URL(req.url);
    const parsed = ListShipmentsDto.safeParse(Object.fromEntries(url.searchParams.entries()));
    if (!parsed.success) throw new ApiError("VALIDATION_ERROR", "Invalid query parameters");
    return NextResponse.json(await listShipments(parsed.data));
  } catch (e) {
    return toErrorResponse(e);
  }
}

export async function POST(req: Request) {
  try {
    const user = await getSessionUser(req);
    if (!user) throw new ApiError("UNAUTHENTICATED", "Sign in required");
    const parsed = CreateShipmentDto.safeParse(await readJson(req));
    if (!parsed.success) throw new ApiError("VALIDATION_ERROR", "Invalid body");
    const shipment = await createShipment(user, parsed.data);
    return NextResponse.json({ shipment }, { status: 201 });
  } catch (e) {
    return toErrorResponse(e);
  }
}
