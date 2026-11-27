/**
 * Telling a UIPI block apart from input that got through. On a real host the pointer froze while
 * WireGuard's window (High) was in front of a PPM at Medium, with nothing logged: SendInput
 * reports every event as sent even when UIPI drops them.
 */
import { afterEach, describe, expect, it } from "bun:test";
import {
  classifyInputBlock, currentInputBlock, describeInputBlock, INTEGRITY, noticeFor, onInputBlockChange,
  publishInputBlock, resetInputBlockForTests, type ForegroundProcess,
} from "../../../../src/services/remote-desktop/remote-desktop-input-block.ts";
import { inspectProcess, ownIntegrity } from "../../../../src/services/remote-desktop/remote-desktop-win32-integrity.ts";

const wireguard: ForegroundProcess = { pid: 7904, exe: "wireguard.exe", integrity: INTEGRITY.high };
const browser: ForegroundProcess = { pid: 2544, exe: "browser.exe", integrity: INTEGRITY.medium };
const sandboxed: ForegroundProcess = { pid: 39864, exe: "browser.exe", integrity: INTEGRITY.low };
const ok = { attached: true, sent: 1, count: 1, ownIntegrity: INTEGRITY.medium };

describe("why input did not land", () => {
  it("an administrator window in front swallows input that SendInput reports as sent", () => {
    expect(classifyInputBlock({ ...ok, foreground: wireguard })).toBe("elevated-window");
  });

  it("a window PPM cannot even inspect counts as outranking it", () => {
    expect(classifyInputBlock({ ...ok, foreground: { pid: 5, exe: null, integrity: null } })).toBe("elevated-window");
  });

  it("a window at PPM's level or below receives the input", () => {
    expect(classifyInputBlock({ ...ok, foreground: browser })).toBeNull();
    expect(classifyInputBlock({ ...ok, foreground: sandboxed })).toBeNull();
    expect(classifyInputBlock({ ...ok, foreground: null })).toBeNull();
  });

  it("PPM itself running as administrator reaches administrator windows", () => {
    expect(classifyInputBlock({ ...ok, ownIntegrity: INTEGRITY.high, foreground: wireguard })).toBeNull();
  });

  it("concludes nothing from the foreground when PPM's own level is unknown", () => {
    expect(classifyInputBlock({ ...ok, ownIntegrity: null, foreground: wireguard })).toBeNull();
  });

  it("the desktop and the SendInput count are still checked first", () => {
    expect(classifyInputBlock({ ...ok, attached: false, foreground: wireguard })).toBe("desktop");
    expect(classifyInputBlock({ ...ok, sent: 0, foreground: browser })).toBe("rejected");
  });

  it("names the window and says what to do about it", () => {
    const line = describeInputBlock("elevated-window", 1, 1, wireguard);
    expect(line).toContain("wireguard.exe (pid 7904)");
    expect(line).toContain("administrator");
    expect(line).toContain("Bring another window to the front");
    expect(describeInputBlock("rejected", 0, 2, null)).toBe("input blocked: SendInput accepted 0/2 events");
  });
});

describe("telling every open viewer", () => {
  afterEach(() => resetInputBlockForTests());

  it("passes each change on, once, including the change back to 'gets through'", () => {
    const seen: Array<unknown> = [];
    const stop = onInputBlockChange((n) => seen.push(n));
    publishInputBlock(noticeFor("elevated-window", wireguard));
    publishInputBlock(noticeFor("elevated-window", wireguard));
    expect(currentInputBlock()).toEqual({ reason: "elevated-window", app: "wireguard.exe" });
    publishInputBlock(noticeFor(null, browser));
    expect(seen).toEqual([{ reason: "elevated-window", app: "wireguard.exe" }, null]);
    stop();
    publishInputBlock(noticeFor("elevated-window", wireguard));
    expect(seen).toHaveLength(2);
  });

  it("tells the viewer only about the block it can act on", () => {
    expect(noticeFor("desktop", null)).toBeNull();
    expect(noticeFor("rejected", browser)).toBeNull();
  });

  it("one listener failing does not stop the others", () => {
    const seen: unknown[] = [];
    onInputBlockChange(() => { throw new Error("socket gone"); });
    onInputBlockChange((n) => seen.push(n));
    publishInputBlock(noticeFor("elevated-window", wireguard));
    expect(seen).toHaveLength(1);
  });
});

/** Reads only this test process's own token: no window, no input. */
describe.if(process.platform === "win32")("integrity levels from Windows", () => {
  it("reads this process's own level, and the same through its pid", () => {
    const mine = ownIntegrity();
    expect(mine).not.toBeNull();
    expect([INTEGRITY.medium, INTEGRITY.high, INTEGRITY.system]).toContain(mine!);
    const me = inspectProcess(process.pid);
    expect(me?.integrity).toBe(mine);
    expect(me?.exe?.toLowerCase()).toMatch(/bun/);
  });
});
