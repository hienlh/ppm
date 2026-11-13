/**
 * A terminal tab learns from the server whether an AI typed into its shell: the `session` message
 * carries `aiMark` only for a shell that keeps the AI-chat mark, so the tab can show its badge.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { terminalWebSocket } from "../../../src/server/ws/terminal.ts";
import { terminalService } from "../../../src/services/terminal.service.ts";

const made: string[] = [];
afterEach(() => { for (const id of made.splice(0)) terminalService.kill(id); });

function attach(aiMark: boolean): Array<Record<string, unknown>> {
  const id = terminalService._createWithPty({ write() {}, resize() {}, kill() {}, closed: false });
  made.push(id);
  terminalService.get(id)!.aiMark = aiMark;
  const sent: string[] = [];
  terminalWebSocket.open({ data: { type: "terminal", id }, send: (data: string) => { sent.push(data); } });
  return sent.filter((s) => s.startsWith("{")).map((s) => JSON.parse(s));
}

describe("terminal socket session message", () => {
  it("says aiMark for a shell an AI typed into, and nothing for any other", () => {
    expect(attach(true)).toEqual([{ type: "session", id: made[0], aiMark: true }]);
    expect(attach(false)).toEqual([{ type: "session", id: made[1] }]);
  });
});
