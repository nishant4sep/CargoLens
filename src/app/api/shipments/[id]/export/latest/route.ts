/** Contract row 17 — GET /api/shipments/:id/export/latest — exact recorded CSV bytes. */
import { NextResponse } from "next/server";
import { ApiError, getSessionUser, toErrorResponse } from "@/server/http";
import { getLatestExport } from "@/server/services/workflow";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, ctx: Ctx) {
  try {
    const user = await getSessionUser(req);
    if (!user) throw new ApiError("UNAUTHENTICATED", "Sign in required");
    const { id } = await ctx.params;
    const record = await getLatestExport(user, id);
    return new NextResponse(record.csvContent, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${record.fileName}"`,
        "x-csv-sha256": record.csvSha256,
        "x-format-version": record.formatVersion,
      },
    });
  } catch (e) {
    return toErrorResponse(e);
  }
}
