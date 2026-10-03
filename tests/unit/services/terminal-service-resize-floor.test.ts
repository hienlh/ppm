import { describe, expect, test } from "bun:test";
import { TerminalService, type PtyHandle } from "../../../src/services/terminal.service";

// A hidden xterm is fit to FitAddon's floor, 2x1, and zsh corrupts its heap redrawing a prompt
// that narrow (src/shared/terminal-size.ts). The service is the one door to the PTY, so it drops
// such a size whichever browser sent it, including one still running a bundle without the guard.
function recordingPty() {
  const sizes: Array<[number, number]> = [];
  const pty: PtyHandle = { write: () => {}, resize: (cols, rows) => { sizes.push([cols, rows]); }, kill: () => {}, closed: false };
  return { pty, sizes };
}

describe("terminal resize floor", () => {
  test("drops FitAddon's 2x1, anything under the floor, and a malformed size", () => {
    const service = new TerminalService();
    const { pty, sizes } = recordingPty();
    const id = service._createWithPty(pty);
    // Literal sizes rather than the floor's constants, so lowering the floor fails here too.
    service.resize(id, 2, 1);
    service.resize(id, 2, 24);
    service.resize(id, 19, 40);
    service.resize(id, 200, 1);
    service.resize(id, NaN, NaN);
    expect(sizes).toEqual([]);
    service.kill(id);
  });

  test("passes the floor itself and an ordinary size", () => {
    const service = new TerminalService();
    const { pty, sizes } = recordingPty();
    const id = service._createWithPty(pty);
    service.resize(id, 20, 2);
    service.resize(id, 156, 20);
    expect(sizes).toEqual([[20, 2], [156, 20]]);
    service.kill(id);
  });
});
