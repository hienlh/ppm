import { describe, expect, it } from "bun:test";
import { whisperBusy, withWhisperLock } from "../../../src/services/speech-to-text/whisper-run-lock.ts";

describe("withWhisperLock", () => {
  it("runs one holder at a time, in order, and says it is busy until the last one ends", async () => {
    const order: string[] = [];
    let release!: () => void;
    const first = withWhisperLock(() => new Promise<void>((r) => { order.push("first start"); release = () => { order.push("first end"); r(); }; }));
    const second = withWhisperLock(async () => { order.push("second"); });
    await Promise.resolve();
    expect(whisperBusy()).toBe(true);
    expect(order).toEqual(["first start"]);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["first start", "first end", "second"]);
    expect(whisperBusy()).toBe(false);
  });

  it("does not let one failure block the next holder", async () => {
    await expect(withWhisperLock(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(await withWhisperLock(async () => 42)).toBe(42);
    expect(whisperBusy()).toBe(false);
  });
});
