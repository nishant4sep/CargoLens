/**
 * The signed-file stream — the TARGET of the #11 302. NOT in the 19-endpoint
 * contract on purpose: this is the local driver's presigned-URL equivalent.
 * Auth model = S3 presigning: possession of an unguessable, 5-minute-expiring
 * HMAC token IS the capability; no session cookie needed here (the ISSUING
 * route above demands the session).
 *
 * Tokens only ever appear in server-minted redirect targets — never logged,
 * never stored.
 */
import { NextResponse } from "next/server";
import { toErrorResponse } from "@/server/http";
import { prisma } from "@/lib/prisma";
import { openDocument, verifyFileToken } from "@/server/storage";

type Ctx = { params: Promise<{ token: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  try {
    const { token } = await ctx.params;
    const payload = verifyFileToken(token);
    if (!payload) {
      return NextResponse.json(
        { error: { code: "FORBIDDEN", message: "Invalid or expired file link" } },
        { status: 403 },
      );
    }
    const document = await prisma.document.findUnique({
      where: { id: payload.documentId },
      select: { fileName: true, mimeType: true, storagePath: true },
    });
    if (!document) {
      return NextResponse.json(
        { error: { code: "NOT_FOUND", message: "Document no longer exists" } },
        { status: 404 },
      );
    }
    const bytes = await openDocument(document.storagePath);
    if (!bytes) {
      // DB row without its file = storage integrity failure — logged, opaque to clients.
      console.error(`[storage] file missing for document ${payload.documentId}`);
      return NextResponse.json(
        { error: { code: "INTERNAL", message: "Stored file is unavailable" } },
        { status: 500 },
      );
    }
    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        "content-type": document.mimeType,
        "content-disposition": `inline; filename="${encodeURIComponent(document.fileName)}"`,
        "cache-control": "private, no-store",
      },
    });
  } catch (e) {
    return toErrorResponse(e);
  }
}
