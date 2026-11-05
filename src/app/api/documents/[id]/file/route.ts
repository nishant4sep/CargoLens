/**
 * Contract row 11 — GET /api/documents/:id/file — session required, then 302
 * to a 5-minute signed URL. The signed URL's TARGET (/api/files/<token>) is
 * the local driver's presigned-URL equivalent; the contract only fixes the
 * 302 semantics (the document pane follows it and renews when expired).
 */
import { NextResponse } from "next/server";
import { ApiError, getSessionUser, toErrorResponse } from "@/server/http";
import { prisma } from "@/lib/prisma";
import { signFileToken } from "@/server/storage";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, ctx: Ctx) {
  try {
    const user = await getSessionUser(req);
    if (!user) throw new ApiError("UNAUTHENTICATED", "Sign in required");
    const { id } = await ctx.params;
    const document = await prisma.document.findUnique({
      where: { id },
      select: { id: true, shipmentId: true },
    });
    if (!document) throw new ApiError("NOT_FOUND", "Document not found", { documentId: id });

    const token = signFileToken(document.id); // 5-minute capability (PRD §9)
    return NextResponse.redirect(new URL(`/api/files/${token}`, req.url), { status: 302 });
  } catch (e) {
    return toErrorResponse(e);
  }
}
