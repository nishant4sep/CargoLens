/**
 * Contract row 9 — POST /api/documents/:id/extract — the explicit per-document
 * "Extract with AI" action (Phase 5). A DUMB route, like every row: session in,
 * service call, JSON out. All rules (404, 409 zombie/EXPORTED, 503 no-provider,
 * claiming, provider I/O outside tx, AI-layer-only persistence, audits,
 * recompute) live in the service, whose ApiErrors land here via toErrorResponse.
 */
import { NextResponse } from "next/server";
import { ApiError, getSessionUser, toErrorResponse } from "@/server/http";
import { extractDocument } from "@/server/services/extract";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, ctx: Ctx) {
  try {
    const user = await getSessionUser(req);
    if (!user) throw new ApiError("UNAUTHENTICATED", "Sign in required");
    const { id } = await ctx.params;
    const result = await extractDocument(user, id);
    // Deliberate serialization (BigInt never crosses JSON) — extraction carries
    // only statuses/strings/counts, but the shape stays explicit per contract.
    return NextResponse.json(result);
  } catch (e) {
    return toErrorResponse(e);
  }
}
