/**
 * The `ppm` CLI's stop connects to a chat's socket marked `?viewer=0`: a program acting on the
 * chat, not a screen showing it. It is never handed a request meant for the device the user is
 * looking at — opening a tab, which it could neither do nor answer — so with no screen connected
 * such a request reaches nobody and says so at once instead of waiting for an answer.
 */
import { expect, it } from "bun:test";
import "../../test-setup.ts";
import { chatService } from "../../../src/services/chat.service.ts";
import { chatSocketData, chatWebSocket, deliverToChattingDevice } from "../../../src/server/ws/chat.ts";
import { chatSocketPath } from "../../../src/cli/utils/chat-ws-cancel.ts";

function socketFrom(sessionId: string, path: string) {
  const url = new URL(path, "http://h");
  const messages: Array<{ type: string }> = [];
  const socket = { data: chatSocketData(sessionId, "demo", url.searchParams), send: (json: string) => messages.push(JSON.parse(json)) };
  chatWebSocket.open(socket as never);
  return { socket, probes: () => messages.filter((m) => m.type === "probe") };
}

it("marks the CLI's stop socket as no screen, and a browser's socket as one", () => {
  const cli = chatSocketData("s", "demo", new URL(chatSocketPath("demo", "s", "claude"), "http://h").searchParams);
  expect(cli).toMatchObject({ nonViewer: true, providerHint: "claude" });
  expect(chatSocketData("s", "demo", new URLSearchParams("providerId=claude")).nonViewer).toBeUndefined();
});

it("hands a tab request to the screens showing the chat, never to the CLI's stop socket", async () => {
  const session = await chatService.createSession("mock", {});
  const cli = socketFrom(session.id, chatSocketPath("demo", session.id));
  try {
    expect(deliverToChattingDevice(session.id, { type: "probe" }, { strict: false })).toBe(0);
    expect(cli.probes()).toHaveLength(0);
    const screen = socketFrom(session.id, `/ws/project/demo/chat/${session.id}`);
    expect(deliverToChattingDevice(session.id, { type: "probe" }, { strict: false })).toBe(1);
    expect(screen.probes()).toHaveLength(1);
    expect(cli.probes()).toHaveLength(0);
    chatWebSocket.close(screen.socket as never);
  } finally {
    chatWebSocket.close(cli.socket as never);
  }
});
