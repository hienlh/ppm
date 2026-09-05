import { describe, test, expect } from "bun:test";
import {
  decideNamedProbeAction, type NamedProbeState,
} from "../../../../src/services/named-tunnel/named-tunnel-probe-state.ts";

const THRESHOLD = 3; // small threshold — the arithmetic is the same at any size

describe("decideNamedProbeAction", () => {
  test("unhealthy below threshold just watches, counting up", () => {
    let state: NamedProbeState = { failCount: 0, restartAttempted: false };
    for (let i = 1; i < THRESHOLD; i++) {
      const { action, nextState } = decideNamedProbeAction(false, state, THRESHOLD);
      expect(action).toEqual({ type: "watch" });
      expect(nextState).toEqual({ failCount: i, restartAttempted: false });
      state = nextState;
    }
  });

  test("full state machine: unreachable×N -> restart once -> unreachable×N -> warn+stop (no further restart) -> healthy -> re-armed", () => {
    let state: NamedProbeState = { failCount: 0, restartAttempted: false };

    // Unreachable × (threshold - 1): just watching.
    for (let i = 0; i < THRESHOLD - 1; i++) {
      state = decideNamedProbeAction(false, state, THRESHOLD).nextState;
    }
    expect(state).toEqual({ failCount: THRESHOLD - 1, restartAttempted: false });

    // Threshold reached, first time -> restart once, budget consumed, counter reset.
    let decision = decideNamedProbeAction(false, state, THRESHOLD);
    expect(decision.action).toEqual({ type: "restart-once" });
    expect(decision.nextState).toEqual({ failCount: 0, restartAttempted: true });
    state = decision.nextState;

    // A bare spawn success (simulated by the caller NOT resetting restartAttempted —
    // this is the regression this state machine exists to prevent) must not be
    // representable here: the only way back to restartAttempted:false is "healthy".
    // Unreachable again × (threshold - 1): still just watching, restart budget spent.
    for (let i = 0; i < THRESHOLD - 1; i++) {
      state = decideNamedProbeAction(false, state, THRESHOLD).nextState;
      expect(state.restartAttempted).toBe(true); // never silently re-armed mid-count
    }

    // Threshold reached again, restart already attempted -> warn and stop, NEVER restart again.
    decision = decideNamedProbeAction(false, state, THRESHOLD);
    expect(decision.action).toEqual({ type: "warn-and-stop" });
    expect(decision.nextState).toEqual({ failCount: 0, restartAttempted: true });
    state = decision.nextState;

    // Keep failing forever afterwards — must stay warn-and-stop, never restart-once again.
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < THRESHOLD - 1; i++) state = decideNamedProbeAction(false, state, THRESHOLD).nextState;
      decision = decideNamedProbeAction(false, state, THRESHOLD);
      expect(decision.action).toEqual({ type: "warn-and-stop" });
      state = decision.nextState;
    }

    // Finally healthy -> flag re-armed AND fail count cleared in one shot.
    decision = decideNamedProbeAction(true, state, THRESHOLD);
    expect(decision.action).toEqual({ type: "healthy" });
    expect(decision.nextState).toEqual({ failCount: 0, restartAttempted: false });
  });

  test("healthy always resets regardless of prior state", () => {
    const dirty: NamedProbeState = { failCount: 41, restartAttempted: true };
    const { action, nextState } = decideNamedProbeAction(true, dirty, THRESHOLD);
    expect(action).toEqual({ type: "healthy" });
    expect(nextState).toEqual({ failCount: 0, restartAttempted: false });
  });

  test("after re-arming via healthy, a fresh unreachable run gets its own restart-once", () => {
    let state = decideNamedProbeAction(true, { failCount: 99, restartAttempted: true }, THRESHOLD).nextState;
    for (let i = 0; i < THRESHOLD - 1; i++) state = decideNamedProbeAction(false, state, THRESHOLD).nextState;
    const decision = decideNamedProbeAction(false, state, THRESHOLD);
    expect(decision.action).toEqual({ type: "restart-once" });
  });
});
