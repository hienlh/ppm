/**
 * When the tabs' and windows' code is loaded ahead of use, and how: it is a download, so a
 * device that might be paying for data is left alone, and it is main-thread work, so each
 * module waits for an idle period of its own.
 */
import { describe, expect, it } from "bun:test";
import { preloadWhenIdle, shouldPreloadUi, type WhenIdle } from "../../../src/web/lib/preload-ui";

describe("shouldPreloadUi", () => {
  it("preloads on a desktop, whatever the browser says about its connection", () => {
    expect(shouldPreloadUi(undefined, false)).toBe(true);
    expect(shouldPreloadUi({ effectiveType: "4g" }, false)).toBe(true);
    expect(shouldPreloadUi({ effectiveType: "3g" }, false)).toBe(true);
  });

  it("never with data saver on, or over 2G", () => {
    expect(shouldPreloadUi({ saveData: true, effectiveType: "4g" }, false)).toBe(false);
    expect(shouldPreloadUi({ saveData: true, type: "wifi" }, true)).toBe(false);
    expect(shouldPreloadUi({ effectiveType: "2g" }, false)).toBe(false);
    expect(shouldPreloadUi({ effectiveType: "slow-2g" }, false)).toBe(false);
    expect(shouldPreloadUi({ effectiveType: "2g", type: "wifi" }, true)).toBe(false);
  });

  it("on a phone or tablet only when it says it is on Wi-Fi or a cable", () => {
    expect(shouldPreloadUi({ type: "wifi", effectiveType: "4g" }, true)).toBe(true);
    expect(shouldPreloadUi({ type: "ethernet" }, true)).toBe(true);
    expect(shouldPreloadUi({ type: "cellular", effectiveType: "4g" }, true)).toBe(false);
    expect(shouldPreloadUi({ effectiveType: "4g" }, true)).toBe(false);
    // Safari on an iPhone has no `navigator.connection` at all.
    expect(shouldPreloadUi(undefined, true)).toBe(false);
  });
});

/** An idle scheduler the test steps by hand. */
function manualIdle() {
  const queue: Array<() => void> = [];
  const idle: WhenIdle = (run) => {
    queue.push(run);
    return () => {
      const at = queue.indexOf(run);
      if (at >= 0) queue.splice(at, 1);
    };
  };
  /** Fire the idle period asked for, and let whatever it started settle. */
  const fire = async () => {
    const run = queue.shift();
    if (!run) throw new Error("no idle period was asked for");
    run();
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };
  return { idle, queue, fire };
}

describe("preloadWhenIdle", () => {
  it("starts each task in an idle period of its own", async () => {
    const { idle, queue, fire } = manualIdle();
    const started: number[] = [];
    preloadWhenIdle([0, 1, 2].map((n) => async () => { started.push(n); }), idle);

    expect(started).toEqual([]);
    await fire();
    expect(started).toEqual([0]);
    await fire();
    expect(started).toEqual([0, 1]);
    await fire();
    expect(started).toEqual([0, 1, 2]);
    expect(queue).toHaveLength(0);
  });

  it("asks for the next idle period only once the task before has settled", async () => {
    const { idle, queue, fire } = manualIdle();
    let finish!: () => void;
    const started: number[] = [];
    preloadWhenIdle([
      () => { started.push(0); return new Promise<void>((resolve) => { finish = resolve; }); },
      async () => { started.push(1); },
    ], idle);

    await fire();
    expect(queue).toHaveLength(0);
    finish();
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(queue).toHaveLength(1);
    await fire();
    expect(started).toEqual([0, 1]);
  });

  it("carries on past a task that fails", async () => {
    const { idle, fire } = manualIdle();
    const started: number[] = [];
    preloadWhenIdle([
      async () => { started.push(0); throw new Error("chunk missing"); },
      () => { started.push(1); throw new Error("thrown, not rejected"); },
      async () => { started.push(2); },
    ], idle);

    await fire();
    await fire();
    await fire();
    expect(started).toEqual([0, 1, 2]);
  });

  it("stops when asked, including the idle period it was waiting for", async () => {
    const { idle, queue, fire } = manualIdle();
    const started: number[] = [];
    const stop = preloadWhenIdle([0, 1, 2].map((n) => async () => { started.push(n); }), idle);

    await fire();
    expect(queue).toHaveLength(1);
    stop();
    expect(queue).toHaveLength(0);
    expect(started).toEqual([0]);
  });

  it("does not start the next task when stopped while one is running", async () => {
    const { idle, queue, fire } = manualIdle();
    let finish!: () => void;
    const started: number[] = [];
    const stop = preloadWhenIdle([
      () => { started.push(0); return new Promise<void>((resolve) => { finish = resolve; }); },
      async () => { started.push(1); },
    ], idle);

    await fire();
    stop();
    finish();
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(queue).toHaveLength(0);
    expect(started).toEqual([0]);
  });
});
