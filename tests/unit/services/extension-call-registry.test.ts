import { describe, it, expect } from "bun:test";
import { ExtensionCallRegistry } from "../../../src/services/extension-api/extension-call-registry.ts";

describe("ExtensionCallRegistry", () => {
  it("aborts every call of the generation that ended, and only those", () => {
    const registry = new ExtensionCallRegistry();
    const a = registry.begin(1);
    const b = registry.begin(1);
    const other = registry.begin(2);

    expect(registry.endGeneration(1)).toBe(2);

    expect(a.signal.aborted).toBe(true);
    expect(b.signal.aborted).toBe(true);
    expect((a.signal.reason as Error).name).toBe("AbortError");
    expect(other.signal.aborted).toBe(false);
    expect(registry.count(1)).toBe(0);
    expect(registry.count(2)).toBe(1);
  });

  it("hands an already-aborted signal to a call begun after its generation ended", () => {
    const registry = new ExtensionCallRegistry();
    registry.endGeneration(3);
    const late = registry.begin(3);
    expect(late.signal.aborted).toBe(true);
    expect(registry.count(3)).toBe(0);
    late.end();
  });

  it("stops tracking a call that ended, and ending twice is harmless", () => {
    const registry = new ExtensionCallRegistry();
    const call = registry.begin(1);
    expect(registry.count()).toBe(1);
    call.end();
    call.end();
    expect(registry.count()).toBe(0);
    // A finished call is not aborted by the generation ending later.
    registry.endGeneration(1);
    expect(call.signal.aborted).toBe(false);
  });

  it("reports nothing aborted for a generation with no calls", () => {
    expect(new ExtensionCallRegistry().endGeneration(9)).toBe(0);
  });
});
