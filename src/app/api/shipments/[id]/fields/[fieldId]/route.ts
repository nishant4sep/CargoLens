/** Contract row 12 — PATCH /api/shipments/:id/fields/:fieldId — confirm (no value) or correct. */
import { NextResponse } from "next/server";
import { PatchFieldDto } from "@/server/dto";
import { ApiError, getSessionUser, readJson, toErrorResponse } from "@/server/http";
import { patchField } from "@/server/services/review";

type Ctx = { params: Promise<{ id: string; fieldId: string }> };

export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const user = await getSessionUser(req);
    if (!user) throw new ApiError("UNAUTHENTICATED", "Sign in required");
    const { id, fieldId } = await ctx.params;
    const parsed = PatchFieldDto.safeParse(await readJson(req));
    if (!parsed.success) throw new ApiError("VALIDATION_ERROR", "Invalid body");
    const result = await patchField(user, id, fieldId, parsed.data);
    return NextResponse.json({
      field: result.field,
      shipmentStatus: result.status,
      recomputed: result.recomputed,
    });
  } catch (e) {
    return toErrorResponse(e);
  }
}
