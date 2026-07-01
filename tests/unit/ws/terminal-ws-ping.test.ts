import { describe, it, expect, spyOn, afterEach } from "bun:test";
import { terminalWebSocket } from "../../../src/server/ws/terminal.ts";
import { terminalService } from "../../../src/services/terminal.service.ts";

const PING_MSG = "\x01PING";
const PONG_MSG = "\x01PONG";

function createFakeWs() {
  const messages: string[] = [];
  return {
    data: { type: "terminal", id: "test-session" },
    send: (data: string) => { messages.push(data); },
    messages,
  };
}

describe("terminalWebSocket.message — keepalive ping", () => {
  afterEach(() => {
    spyOn(terminalService, "write").mockRestore();
  });

  it("replies to PING with PONG and does not write to the PTY", () => {
    const writeSpy = spyOn(terminalService, "write").mockImplementation(() => {});
    const ws = createFakeWs();

    terminalWebSocket.message(ws as any, PING_MSG);

    expect(ws.messages).toEqual([PONG_MSG]);
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it("forwards regular input to the PTY (not treated as control)", () => {
    const writeSpy = spyOn(terminalService, "write").mockImplementation(() => {});
    const ws = createFakeWs();

    terminalWebSocket.message(ws as any, "ls -la\r");

    expect(ws.messages).toEqual([]);
    expect(writeSpy).toHaveBeenCalledWith("test-session", "ls -la\r");
  });
});
