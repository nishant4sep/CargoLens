/** Audit ledger writer — the ONLY way services create AuditEvent rows (append-only). */
import type { Prisma } from "@prisma/client";

type Tx = Prisma.TransactionClient;

export function writeAudit(
  tx: Tx,
  data: {
    shipmentId: string;
    shipmentRef: string;
    action: Prisma.AuditEventCreateInput["action"];
    actorId?: string | null;
    actorName: string;
    payload?: Prisma.InputJsonValue;
  },
) {
  return tx.auditEvent.create({
    data: {
      shipmentId: data.shipmentId,
      shipmentRef: data.shipmentRef,
      action: data.action,
      actorId: data.actorId ?? null,
      actorName: data.actorName,
      payload: data.payload ?? undefined,
    },
  });
}
