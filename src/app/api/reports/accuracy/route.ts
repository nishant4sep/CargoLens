/** Contract row 19 — GET /api/reports/accuracy?groupBy=field|supplier */
import { NextResponse } from "next/server";
import { AccuracyQueryDto } from "@/server/dto";
import { ApiError, getSessionUser, toErrorResponse } from "@/server/http";
import { accuracyByField, accuracyBySupplier } from "@/server/services/reports";

export async function GET(req: Request) {
  try {
    if (!(await getSessionUser(req))) throw new ApiError("UNAUTHENTICATED", "Sign in required");
    const url = new URL(req.url);
    const parsed = AccuracyQueryDto.safeParse(Object.fromEntries(url.searchParams.entries()));
    if (!parsed.success) throw new ApiError("VALIDATION_ERROR", "Invalid query parameters");
    return NextResponse.json(
      parsed.data.groupBy === "supplier" ? await accuracyBySupplier() : await accuracyByField(),
    );
  } catch (e) {
    return toErrorResponse(e);
  }
}
