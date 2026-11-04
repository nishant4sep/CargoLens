/** Contract row 13 — POST /api/shipments/:id/checks/:checkId/resolve (accept-with-note). */
import { NextResponse } from "next/server";
import { ResolveCheckDto } from "@/server/dto";
import { ApiError, getSessionUser, readJson, toErrorResponse } from "@/server/http";
import { resolveCheck } from "@/server/services/review";

type Ctx = { params: Promise<{ id: string; checkId: string }> };

export async function POST(req: Request, ctx: Ctx) {
  try {
    const user = await getSessionUser(req);
    if (!user) throw new ApiError("UNAUTHENTICATED", "Sign in required");
    const { id, checkId } = await ctx.params;
    const parsed = ResolveCheckDto.safeParse(await readJson(req));
    if (!parsed.success) throw new ApiError("VALIDATION_ERROR", "Invalid body");
    const result = await resolveCheck(user, id, checkId, parsed.data);
    return NextResponse.json({ check: result.check, shipmentStatus: result.status, recomputed: result.recomputed });
  } catch (e) {
    return toErrorResponse(e);
  }
}
