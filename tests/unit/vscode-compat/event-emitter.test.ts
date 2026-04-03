import { describe, it, expect } from "bun:test";
import { EventEmitter } from "../../../packages/vscode-compat/src/event-emitter.ts";

describe("EventEmitter", () => {
  it("fires listeners with data", () => {
    const emitter = new EventEmitter<string>();
    const received: string[] = [];
    emitter.event((data) => received.push(data));

    emitter.fire("hello");
    emitter.fire("world");

    expect(received).toEqual(["hello", "world"]);
  });

  it("supports multiple listeners", () => {
    const emitter = new EventEmitter<number>();
    let a = 0, b = 0;
    emitter.event((n) => { a += n; });
    emitter.event((n) => { b += n * 2; });

    emitter.fire(5);

    expect(a).toBe(5);
    expect(b).toBe(10);
  });

  it("listener disposal stops future events", () => {
    const emitter = new EventEmitter<string>();
    const received: string[] = [];
    const disposable = emitter.event((d) => received.push(d));

    emitter.fire("before");
    disposable.dispose();
    emitter.fire("after");

    expect(received).toEqual(["before"]);
  });

  it("dispose clears all listeners", () => {
    const emitter = new EventEmitter<string>();
    const received: string[] = [];
    emitter.event((d) => received.push(d));
    emitter.event((d) => received.push(d + "!"));

    emitter.fire("test");
    expect(received.length).toBe(2);

    emitter.dispose();
    emitter.fire("after-dispose");

    expect(received.length).toBe(2);
  });

  it("listener error does not break other listeners", () => {
    const emitter = new EventEmitter<number>();
    const received: number[] = [];

    emitter.event(() => { throw new Error("boom"); });
    emitter.event((n) => received.push(n));

    emitter.fire(42);

    expect(received).toEqual([42]);
  });
});
