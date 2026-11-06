/**
 * PURE — submit-guard (src/lib/submit-guard.ts): the P4.5 regression test for
 * the new-shipment modal's double-submission defect. The guard's contract:
 * begin() is atomic (two synchronous clicks cannot both win), end() releases
 * FAILED attempts, done() blocks permanently after SUCCESS, reset() re-arms on
 * dialog close.
 */
import { describe, expect, it } from "vitest";
import { createSubmitGuard } from "@/lib/submit-guard";

describe("submit-guard (double-submission regression)", () => {
  it("begin() wins exactly once — a second synchronous begin is refused", () => {
    const g = createSubmitGuard();
    expect(g.inFlight).toBe(false);
    expect(g.begin()).toBe(true);
    expect(g.inFlight).toBe(true);
    expect(g.begin()).toBe(false); // the double-click lands here
    expect(g.begin()).toBe(false);
  });

  it("end() releases a FAILED attempt so the user can retry", () => {
    const g = createSubmitGuard();
    g.begin();
    g.end();
    expect(g.inFlight).toBe(false);
    expect(g.begin()).toBe(true);
  });

  it("done() blocks permanently — even the finally-block's end() cannot re-arm", () => {
    const g = createSubmitGuard();
    g.begin();
    g.done(); // success path
    expect(g.isDone).toBe(true);
    expect(g.inFlight).toBe(false);
    expect(g.begin()).toBe(false);
    g.end(); // the modal's finally still runs — must NOT re-arm
    expect(g.begin()).toBe(false);
  });

  it("reset() on dialog close re-arms a fresh submit opportunity", () => {
    const g = createSubmitGuard();
    g.begin();
    g.done();
    g.reset();
    expect(g.isDone).toBe(false);
    expect(g.begin()).toBe(true);
  });

  it("the modal's full lifecycle: fail once, retry, succeed, stay closed", () => {
    const g = createSubmitGuard();
    expect(g.begin()).toBe(true); // first click
    g.end(); // server 422
    expect(g.begin()).toBe(true); // retry click
    g.done(); // 201 Created
    expect(g.begin()).toBe(false); // stray third click after the response
    g.reset(); // user closes and reopens the dialog
    expect(g.begin()).toBe(true);
  });
});
