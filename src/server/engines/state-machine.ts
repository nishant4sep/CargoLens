/**
 * CargoLens shipment state machine (ADR-06).
 *
 * Policy encoded here (from the brief + PRD §5):
 *  - "Nothing exports until cleared": EXPORT only from APPROVED.
 *  - READY_FOR_APPROVAL is derived, never clicked: the guard requires ALL required
 *    fields human-cleared AND zero unresolved blocking checks (services pass the
 *    blockingFails count in the event payload).
 *  - APPROVED is automatically invalidated by any write to fields/documents/checks.
 *  - EXPORTED is terminal: no field/document writes afterwards.
 *
 * This module is PURE: services call it, persist the result, and write audit events;
 * the UI simply reflects what the state says. One logic file, exhaustively testable.
 */

export type ShipmentStatus =
  | "DRAFT"
  | "PROCESSING"
  | "NEEDS_REVIEW"
  | "READY_FOR_APPROVAL"
  | "APPROVED"
  | "EXPORTED";

export type ShipmentEvent =
  | { type: "EXTRACTION_STARTED" }
  /** all docs for the shipment reached a terminal per-document status */
  | { type: "DOCS_REACHED_TERMINAL" }
  /** invariant recompute finished; blockingFails = count of unresolved BLOCKING FAILs */
  | { type: "INVARIANTS_RECOMPUTED"; blockingFails: number }
  | { type: "APPROVE" }
  | { type: "EXPORT" }
  | { type: "APPROVAL_REVOKED_MANUALLY" }
  /** any human write: confirm / correct / manual-entry of field or document data */
  | { type: "HUMAN_WRITE" };

export type TransitionResult =
  | { ok: true; next: ShipmentStatus; approvalRevoked?: boolean }
  | { ok: false; reason: string };

const ERR: Record<string, string> = {
  APPROVE: "NOT_READY_FOR_APPROVAL",
  EXPORT: "PREMATURE_EXPORT",
  HUMAN_WRITE: "WRITE_NOT_ALLOWED_IN_STATUS",
  EXTRACTION_STARTED: "EXTRACTION_NOT_ALLOWED_IN_STATUS",
  DEFAULT: "ILLEGAL_TRANSITION",
};

export function transition(status: ShipmentStatus, event: ShipmentEvent): TransitionResult {
  const fail = (event: ShipmentEvent): TransitionResult => ({
    ok: false,
    reason: ERR[event.type] ?? ERR.DEFAULT,
  });

  switch (status) {
    case "DRAFT": {
      if (event.type === "EXTRACTION_STARTED") return { ok: true, next: "PROCESSING" };
      return fail(event); // DRAFT has no documents/fields yet
    }

    case "PROCESSING": {
      if (event.type === "DOCS_REACHED_TERMINAL") return { ok: true, next: "NEEDS_REVIEW" };
      if (event.type === "INVARIANTS_RECOMPUTED") return { ok: true, next: "PROCESSING" };
      return fail(event); // e.g. HUMAN_WRITE during processing → API maps to 409
    }

    case "NEEDS_REVIEW": {
      switch (event.type) {
        case "HUMAN_WRITE":
          return { ok: true, next: "NEEDS_REVIEW" };
        case "INVARIANTS_RECOMPUTED":
          return {
            ok: true,
            next: event.blockingFails === 0 ? "READY_FOR_APPROVAL" : "NEEDS_REVIEW",
          };
        case "EXTRACTION_STARTED":
          return { ok: true, next: "PROCESSING" }; // retry/re-extract mid-review
        default:
          return fail(event);
      }
    }

    case "READY_FOR_APPROVAL": {
      switch (event.type) {
        case "APPROVE":
          return { ok: true, next: "APPROVED" };
        case "HUMAN_WRITE":
          return { ok: true, next: "NEEDS_REVIEW" }; // any write re-opens review
        case "INVARIANTS_RECOMPUTED":
          return {
            ok: true,
            next: event.blockingFails === 0 ? "READY_FOR_APPROVAL" : "NEEDS_REVIEW",
          };
        case "EXTRACTION_STARTED":
          return { ok: true, next: "PROCESSING" };
        default:
          return fail(event);
      }
    }

    case "APPROVED": {
      switch (event.type) {
        case "EXPORT":
          // the export gate is ALSO verified by the export service; state is the second gate
          return { ok: true, next: "EXPORTED" };
        case "HUMAN_WRITE":
        case "EXTRACTION_STARTED":
          return { ok: true, next: "NEEDS_REVIEW", approvalRevoked: true };
        case "INVARIANTS_RECOMPUTED":
          if (event.blockingFails > 0) {
            return { ok: true, next: "NEEDS_REVIEW", approvalRevoked: true };
          }
          return { ok: true, next: "APPROVED" };
        case "APPROVAL_REVOKED_MANUALLY":
          return { ok: true, next: "NEEDS_REVIEW", approvalRevoked: true };
        default:
          return fail(event);
      }
    }

    case "EXPORTED": {
      return fail(event); // terminal; downloads are audit-only and emit no state event
    }
  }
}
