/** Long operations outlive the request that started them, and must not grow without bound. */
import { describe, it, expect, beforeEach } from "bun:test";
import {
  createOperation, failOperation, finishOperation, getOperation,
  updateOperation, _resetOperations,
} from "../../../src/services/android/android-operations.ts";

beforeEach(() => _resetOperations());

describe("operations", () => {
  it("starts pending and carries progress detail", () => {
    const op = createOperation("android.start", "spawning");
    expect(getOperation(op.id)?.state).toBe("pending");
    updateOperation(op.id, { state: "running", detail: "booting (3s)" });
    expect(getOperation(op.id)?.detail).toBe("booting (3s)");
  });

  it("records a result and an end time on success", () => {
    const op = createOperation<{ pid: number }>("android.start");
    finishOperation(op.id, { pid: 42 });
    const done = getOperation(op.id)!;
    expect(done.state).toBe("succeeded");
    expect(done.result).toEqual({ pid: 42 });
    expect(done.endedAt).not.toBeNull();
  });

  it("records the error on failure so the client can show why", () => {
    const op = createOperation("android.start");
    failOperation(op.id, "guest did not boot");
    expect(getOperation(op.id)?.state).toBe("failed");
    expect(getOperation(op.id)?.error).toBe("guest did not boot");
  });

  it("caps how many it retains, dropping the oldest", () => {
    const ids = Array.from({ length: 260 }, (_, i) => {
      const op = createOperation("x");
      finishOperation(op.id, i);
      return op.id;
    });
    const alive = ids.filter((id) => getOperation(id) !== null);
    // MAX_OPERATIONS is 200, and the ones dropped are the earliest.
    expect(alive).toEqual(ids.slice(-200));
  });

  it("answers null for an unknown id rather than throwing", () => {
    expect(getOperation("nope")).toBeNull();
  });
});
