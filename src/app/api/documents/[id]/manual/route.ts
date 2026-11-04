/** Contract row 10 — POST /api/documents/:id/manual — manual entry (confidence null). */
import { NextResponse } from "next/server";
import { ManualEntryDto } from "@/server/dto";
import { ApiError, getSessionUser, readJson, toErrorResponse } from "@/server/http";
import { manualEntry } from "@/server/services/review";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, ctx: Ctx) {
  try {
    const user = await getSessionUser(req);
    if (!user) throw new ApiError("UNAUTHENTICATED", "Sign in required");
    const { id } = await ctx.params;
    const parsed = ManualEntryDto.safeParse(await readJson(req));
    if (!parsed.success) throw new ApiError("VALIDATION_ERROR", "Invalid body");
    const result = await manualEntry(user, id, parsed.data);
    return NextResponse.json({ fields: result.written, shipmentStatus: result.status });
  } catch (e) {
    return toErrorResponse(e);
  }
}
