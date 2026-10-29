/**
 * A message's "5m ago" stays current on its own. It used to be refreshed only because the whole
 * transcript was redrawn on every render of the chat; with that gone, each label asks one shared
 * timer, which runs only while a label is mounted.
 */
import { afterAll, describe, expect, it, setSystemTime } from "bun:test";
import { installDom, uninstallDom, mount } from "../../helpers/react-dom";

installDom();
afterAll(uninstallDom);

const { act } = await import("react");
const { formatRelativeDate } = await import("../../../src/web/lib/format-date");
const { MessageActionBar } = await import("../../../src/web/components/chat/message-action-bar");
const { RELATIVE_TIME_TICK_MS } = await import("../../../src/web/hooks/use-relative-time-tick");

describe("relative times", () => {
  it("print an older date the way toLocaleDateString does", () => {
    const old = new Date(Date.now() - 30 * 86_400_000).toISOString();
    expect(formatRelativeDate(old)).toBe(new Date(old).toLocaleDateString(undefined, { month: "short", day: "numeric" }));
    expect(formatRelativeDate(new Date(Date.now() - 5 * 60_000).toISOString())).toBe("5m ago");
  });

  it("move on by themselves, on one timer that stops with the last label", async () => {
    const realSet = globalThis.setInterval;
    const realClear = globalThis.clearInterval;
    const timers = new Map<number, () => void>();
    let nextId = 1;
    globalThis.setInterval = ((fn: () => void, ms: number) => {
      if (ms !== RELATIVE_TIME_TICK_MS) return realSet(fn, ms);
      timers.set(nextId, fn);
      return nextId++;
    }) as typeof setInterval;
    globalThis.clearInterval = ((id: number) => {
      if (!timers.delete(id)) realClear(id);
    }) as typeof clearInterval;
    const start = Date.now();
    try {
      const at = new Date(start - 30_000).toISOString();
      const view = await mount(<><MessageActionBar timestamp={at} content="a" /><MessageActionBar timestamp={at} content="b" /></>);
      expect(timers.size).toBe(1);
      expect([...view.container.querySelectorAll("time")].map((t) => t.textContent)).toEqual(["just now", "just now"]);

      setSystemTime(new Date(start + 60_000));
      await act(async () => { for (const tick of timers.values()) tick(); });
      expect([...view.container.querySelectorAll("time")].map((t) => t.textContent)).toEqual(["1m ago", "1m ago"]);

      await view.unmount();
      expect(timers.size).toBe(0);
    } finally {
      setSystemTime();
      globalThis.setInterval = realSet;
      globalThis.clearInterval = realClear;
    }
  });
});
