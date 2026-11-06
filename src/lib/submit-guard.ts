/**
 * Pure submit guard (P4.5 regression): one closure per dialog instance that
 * makes double-submission impossible by construction.
 *
 * The dashboard modal's observed defect (P4.4 browser E2E): a disabled-while-
 * pending button cannot cover a click that lands after the response but before
 * navigation, and a plain in-flight flag reset in `finally` RE-ARMS the form
 * after success. The guard adds an explicit DONE state:
 *
 *  - begin() is atomic (synchronous check-and-set — two synchronous clicks
 *    cannot both win, closing the stale-state window);
 *  - end() releases a FAILED attempt so the user can retry;
 *  - done() blocks permanently after a SUCCESSFUL submit (navigation may take
 *    time; nothing may fire again);
 *  - reset() re-arms on dialog close.
 *
 * PURE — no React, no fetch. Unit-tested in tests/ui/submit-guard.test.ts,
 * then wired into the new-shipment modal.
 */
export interface SubmitGuard {
  /** Atomic attempt acquisition: false while in flight or already done. */
  begin(): boolean;
  /** Release a FAILED attempt (validation, server error, network). */
  end(): void;
  /** Permanent block — call ONLY after a successful submit. */
  done(): void;
  /** New dialog open: clear every state. */
  reset(): void;
  readonly inFlight: boolean;
  readonly isDone: boolean;
}

export function createSubmitGuard(): SubmitGuard {
  let flying = false;
  let finished = false;
  return {
    begin() {
      if (flying || finished) return false;
      flying = true;
      return true;
    },
    end() {
      flying = false;
    },
    done() {
      flying = false;
      finished = true;
    },
    reset() {
      flying = false;
      finished = false;
    },
    get inFlight() {
      return flying;
    },
    get isDone() {
      return finished;
    },
  };
}
