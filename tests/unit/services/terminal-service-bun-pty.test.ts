import { describe, expect, it } from "bun:test";
import { bunPtyHandle, type BunPtyProcess } from "../../../src/services/terminal.service.ts";

type ExitEvent = { exitCode?: number; signal?: number | string } | undefined;

/** A bun-pty process (the Windows ConPTY path) that exits when the test says so. */
function fakePty() {
  let exitListener: ((e: ExitEvent) => void) | undefined;
  let kills = 0;
  const pty: BunPtyProcess = {
    onData() {},
    onExit(listener) { exitListener = listener; },
    write() {},
    resize() {},
    kill() { kills++; },
    pid: 4242,
  };
  return { pty, exit: (e: ExitEvent) => exitListener!(e), kills: () => kills };
}

describe("bunPtyHandle", () => {
  it("counts a shell that exited by itself as closed, as Bun's own terminal does", () => {
    const fake = fakePty();
    const exits: Array<[number | null, string | null]> = [];
    const handle = bunPtyHandle(fake.pty, () => {}, (code, signal) => { exits.push([code, signal]); });
    expect(handle.closed).toBe(false);
    fake.exit({ exitCode: 0 });
    expect(handle.closed).toBe(true);
    expect(exits).toEqual([[0, null]]);
    expect(handle.pid).toBe(4242);
  });

  it("is closed once killed, and kills the process once", () => {
    const fake = fakePty();
    const handle = bunPtyHandle(fake.pty, () => {}, () => {});
    handle.kill();
    handle.kill();
    expect(handle.closed).toBe(true);
    expect(fake.kills()).toBe(1);
  });
});
