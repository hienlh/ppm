/**
 * Input from one session is injected in arrival order even when an injection takes time — the
 * X11 path for a character outside the keymap sleeps twice, and a Backspace sent right after a
 * Vietnamese letter used to land before it.
 */
import { describe, expect, it } from "bun:test";
import { createInputQueue } from "../../../src/services/remote-desktop/remote-desktop-input-queue.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("remote desktop input queue", () => {
  it("a slow injection is not overtaken by the next message", async () => {
    const q = createInputQueue();
    const done: string[] = [];
    // As the server receives them: Bun does not wait for one handler before the next.
    const a = q.run(async () => { await sleep(25); done.push("text ệ"); });
    const b = q.run(async () => { done.push("Backspace"); });
    const c = q.run(async () => { await sleep(5); done.push("text e"); });
    await Promise.all([a, b, c]);
    expect(done).toEqual(["text ệ", "Backspace", "text e"]);
  });

  it("a failed injection rejects its own call and the queue carries on", async () => {
    const q = createInputQueue();
    const done: string[] = [];
    const bad = q.run(async () => { throw new Error("view-only host"); });
    const good = q.run(async () => { done.push("next"); });
    await expect(bad).rejects.toThrow("view-only host");
    await good;
    expect(done).toEqual(["next"]);
  });
});
