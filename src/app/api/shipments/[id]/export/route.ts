/** Contract row 16 — POST /api/shipments/:id/export — gated by APPROVED + zero unresolved blocking. */
import { NextResponse } from "next/server";
import { ApiError, getSessionUser, toErrorResponse } from "@/server/http";
import { generateExport } from "@/server/services/workflow";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, ctx: Ctx) {
  try {
    const user = await getSessionUser(req);
    if (!user) throw new ApiError("UNAUTHENTICATED", "Sign in required");
    const { id } = await ctx.params;
    return NextResponse.json({ exportRecord: await generateExport(user, id) }, { status: 201 });
  } catch (e) {
    return toErrorResponse(e);
  }
}
