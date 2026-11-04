/**
 * The FULL Zod boundary set (file 04 §5: "Phase 3 pins the full set").
 * Every DTO is `.strict()` — unknown keys are rejected, not ignored — and the
 * fieldKey uses the code-level FIELD_KEYS allowlist, never free text.
 */
import { z } from "zod";
import { FIELD_KEYS } from "@/lib/types";
import type { ShipmentStatus } from "@/server/engines/state-machine";

/** Auth (contract rows 1–3). */
export const LoginDto = z
  .object({ email: z.email(), password: z.string().min(1).max(200) })
  .strict();

/** List query (row 4) — search params arrive as strings. */
export const ListShipmentsDto = z
  .object({
    status: z
      .enum(["DRAFT", "PROCESSING", "NEEDS_REVIEW", "READY_FOR_APPROVAL", "APPROVED", "EXPORTED"] as const satisfies readonly ShipmentStatus[])
      .optional(),
    q: z.string().max(80).optional(),
    supplier: z.string().max(120).optional(),
    page: z.coerce.number().int().min(1).max(10_000).default(1),
  })
  .strict();

/** Create shipment (row 5) — supplier optional; country only meaningful with a name. */
export const CreateShipmentDto = z
  .object({
    supplierName: z.string().min(1).max(120).optional(),
    supplierCountry: z.string().regex(/^[A-Za-z]{2}$/).optional(),
  })
  .strict();

/** Link/unlink supplier (row 7). */
export const PatchShipmentDto = z.object({ supplierId: z.uuid() }).strict();

/** Manual entry (row 10) — values are raw strings; normalization happens in the service. */
export const ManualEntryDto = z
  .object({
    fields: z
      .array(
        z.object({
          fieldKey: z.enum(FIELD_KEYS),
          value: z.string().min(0).max(200),
        }),
      )
      .min(1)
      .max(50),
    lineItems: z
      .array(
        z.object({
          seq: z.number().int().min(1).max(10_000),
          description: z.string().min(1).max(200),
          hsnCode: z.string().regex(/^\d{4,8}$/).optional(),
          unit: z.string().max(20).optional(),
          quantity: z.number().nonnegative(),
          unitPrice: z.number().nonnegative().optional(),
        }),
      )
      .max(200)
      .optional(),
  })
  .strict();

/** Confirm-or-correct a field (row 12): value absent ⇒ confirm-as-extracted. */
export const PatchFieldDto = z.object({ value: z.string().max(200).optional() }).strict();

/** Resolve a blocking discrepancy with a mandatory note (row 13). */
export const ResolveCheckDto = z.object({ note: z.string().min(1).max(500) }).strict();

/** Accuracy report (row 19). */
export const AccuracyQueryDto = z
  .object({ groupBy: z.enum(["field", "supplier"]).default("field") })
  .strict();

export type LoginInput = z.infer<typeof LoginDto>;
export type ListShipmentsInput = z.infer<typeof ListShipmentsDto>;
export type CreateShipmentInput = z.infer<typeof CreateShipmentDto>;
export type PatchShipmentInput = z.infer<typeof PatchShipmentDto>;
export type ManualEntryInput = z.infer<typeof ManualEntryDto>;
export type PatchFieldInput = z.infer<typeof PatchFieldDto>;
export type ResolveCheckInput = z.infer<typeof ResolveCheckDto>;
export type AccuracyQueryInput = z.infer<typeof AccuracyQueryDto>;
