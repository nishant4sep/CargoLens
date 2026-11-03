import { describe, expect, it } from "vitest";
import { transition, type ShipmentEvent, type ShipmentStatus } from "@/server/engines/state-machine";

const E: Record<string, ShipmentEvent> = {
  extract: { type: "EXTRACTION_STARTED" },
  allDocsTerminal: { type: "DOCS_REACHED_TERMINAL" },
  recompute: { type: "INVARIANTS_RECOMPUTED", blockingFails: 0 },
  recomputeFail: { type: "INVARIANTS_RECOMPUTED", blockingFails: 1 },
  approve: { type: "APPROVE" },
  export: { type: "EXPORT" },
  manualRevoke: { type: "APPROVAL_REVOKED_MANUALLY" },
  write: { type: "HUMAN_WRITE" },
};

function expectOk(from: ShipmentStatus, event: ShipmentEvent, next: ShipmentStatus, revoked?: boolean) {
  const r = transition(from, event);
  expect(r.ok).toBe(true);
  if (r.ok) {
    expect(r.next).toBe(next);
    expect(r.approvalRevoked ?? false).toBe(revoked ?? false);
  }
}
function expectFail(from: ShipmentStatus, event: ShipmentEvent, reason?: string) {
  const r = transition(from, event);
  expect(r.ok).toBe(false);
  if (!r.ok && reason) expect(r.reason).toBe(reason);
}

describe("happy lifecycle", () => {
  it("DRAFT —(extraction)→ PROCESSING", () => { expectOk("DRAFT", E.extract, "PROCESSING"); });
  it("PROCESSING —(all docs terminal)→ NEEDS_REVIEW", () => { expectOk("PROCESSING", E.allDocsTerminal, "NEEDS_REVIEW"); });
  it("NEEDS_REVIEW remains while blocking fails exist", () => { expectOk("NEEDS_REVIEW", E.recomputeFail, "NEEDS_REVIEW"); });
  it("NEEDS_REVIEW —(all invariants pass & cleared)→ READY_FOR_APPROVAL", () => { expectOk("NEEDS_REVIEW", E.recompute, "READY_FOR_APPROVAL"); });
  it("READY —(approve)→ APPROVED", () => { expectOk("READY_FOR_APPROVAL", E.approve, "APPROVED"); });
  it("APPROVED —(export)→ EXPORTED", () => { expectOk("APPROVED", E.export, "EXPORTED"); });
});

describe("approval invalidation (the governance core)", () => {
  it("a human write on APPROVED revokes approval and re-opens review", () => {
    expectOk("APPROVED", E.write, "NEEDS_REVIEW", true);
  });
  it("re-extraction on APPROVED revokes approval", () => {
    expectOk("APPROVED", E.extract, "NEEDS_REVIEW", true);
  });
  it("a newly failing invariant on APPROVED revokes approval", () => {
    expectOk("APPROVED", E.recomputeFail, "NEEDS_REVIEW", true);
  });
  it("recompute with zero blocking fails keeps APPROVED", () => {
    expectOk("APPROVED", E.recompute, "APPROVED");
  });
  it("manual manager revoke lands on NEEDS_REVIEW", () => {
    expectOk("APPROVED", E.manualRevoke, "NEEDS_REVIEW", true);
  });
});

describe("derived status discipline", () => {
  it("any write in NEEDS_REVIEW stays in review (no premature READY)", () => {
    expectOk("NEEDS_REVIEW", E.write, "NEEDS_REVIEW");
  });
  it("any write in READY re-opens review", () => {
    expectOk("READY_FOR_APPROVAL", E.write, "NEEDS_REVIEW");
  });
  it("READY recompute with new blocking fail falls back to review", () => {
    expectOk("READY_FOR_APPROVAL", E.recomputeFail, "NEEDS_REVIEW");
  });
});

describe("illegal operations rejected", () => {
  it("no writes in DRAFT (nothing to write against)", () => { expectFail("DRAFT", E.write, "WRITE_NOT_ALLOWED_IN_STATUS"); });
  it("no writes during PROCESSING", () => { expectFail("PROCESSING", E.write, "WRITE_NOT_ALLOWED_IN_STATUS"); });
  it("approve must come from READY", () => { expectFail("NEEDS_REVIEW", E.approve, "NOT_READY_FOR_APPROVAL"); });
  it("export must come from APPROVED", () => { expectFail("READY_FOR_APPROVAL", E.export, "PREMATURE_EXPORT"); });
  it("EXPORTED is terminal for writes", () => { expectFail("EXPORTED", E.write, "WRITE_NOT_ALLOWED_IN_STATUS"); });
  it("EXPORTED is terminal even for revoke", () => { expectFail("EXPORTED", E.manualRevoke); });
  it("no sanitize-free approvals: DRAFT cannot be approved", () => { expectFail("DRAFT", E.approve, "NOT_READY_FOR_APPROVAL"); });
  it("PROCESSING cannot accept export", () => { expectFail("PROCESSING", E.export, "PREMATURE_EXPORT"); });
});
