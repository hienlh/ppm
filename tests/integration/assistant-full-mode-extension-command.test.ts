/**
 * Full mode and an extension's command, through the production path: the real `ui_run_command`
 * tool, the real asker and Full-mode decision (settings, turn provenance), with only the device's
 * command list stubbed — an e2e cannot list an `ext:` command without installing an extension.
 * In a turn the user started, PPM's own command runs with no card and an extension's command
 * still shows one.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import "../test-setup.ts";
import { chatService } from "../../src/services/chat.service.ts";
import { configService } from "../../src/services/config.service.ts";
import { setSessionAssistant } from "../../src/services/db.service.ts";
import { assistantTurnProvenance } from "../../src/services/assistant/assistant-turn-provenance.ts";
import { assistantFullMode } from "../../src/services/assistant/assistant-full-mode-live.ts";
import { approvalAskerFor, createApprovalBroker } from "../../src/services/assistant-mcp/assistant-approval-broker.ts";
import { uiRunCommand } from "../../src/services/assistant-mcp/assistant-ui-command-tools.ts";
import type { UiRequest } from "../../src/services/assistant-mcp/assistant-ui-tools.ts";

const COMMANDS = [
  { id: "settings.open", label: "Open Settings", changesData: true },
  { id: "ext:git-graph.push", label: "Git Graph: Push", changesData: true },
];

/** The chatting device: lists the commands above and runs whatever it is asked. */
function device(ran: string[]): UiRequest {
  return async (_sessionId, body) => {
    if (body.op === "list_commands") return { ok: true, result: { type: "assistant_ui_result", requestId: "r", ok: true, data: { commands: COMMANDS, total: COMMANDS.length } } };
    ran.push(String((body.args as { id?: unknown }).id));
    return { ok: true, result: { type: "assistant_ui_result", requestId: "r", ok: true, data: {} } };
  };
}

let savedAssistant: unknown;
let sessionId = "";
beforeEach(async () => {
  savedAssistant = configService.get("assistant");
  configService.set("assistant", { ...(configService.get("assistant") ?? {}), permission_mode: "full" } as never);
  assistantFullMode.reset();
  sessionId = (await chatService.createSession("claude", {})).id;
  setSessionAssistant(sessionId);
  assistantTurnProvenance.noteMessage({ sessionId, text: "run it", origin: "ws" });
});
afterEach(() => {
  assistantTurnProvenance.turnEnded(sessionId);
  configService.set("assistant", savedAssistant as never);
});

describe("Full mode and ui_run_command", () => {
  it("runs PPM's own command with no card", async () => {
    let cards = 0;
    const ran: string[] = [];
    const ask = approvalAskerFor(sessionId, undefined, createApprovalBroker({ deliver: () => { cards++; return 0; } }), () => false);
    // What the stub device answers after running is not checked: only that it was asked to run.
    await uiRunCommand(sessionId, { id: "settings.open" }, ask, device(ran));
    expect(cards).toBe(0);
    expect(ran).toEqual(["settings.open"]);
  });

  it("still shows a card for an extension's command, and runs nothing when it is not approved", async () => {
    let cards = 0;
    const ran: string[] = [];
    const ask = approvalAskerFor(sessionId, undefined, createApprovalBroker({ deliver: () => { cards++; return 0; } }), () => false);
    const result = await uiRunCommand(sessionId, { id: "ext:git-graph.push" }, ask, device(ran));
    expect(cards).toBe(1);
    expect(result.isError).toBe(true);
    expect(ran).toEqual([]);
  });
});
