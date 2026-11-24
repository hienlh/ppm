/**
 * The chat door a Telegram message goes through takes a reply reference only from Telegram, only
 * for the chat it is sent to, and stores it as a `ppm-reply-v1` block after the user's words — the
 * provider receives the words as the body and the quote as data.
 */
import { afterAll, afterEach, beforeAll, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "../../test-setup.ts";
import "../../../src/server/ws/chat.ts";
import { chatService } from "../../../src/services/chat.service.ts";
import { configService } from "../../../src/services/config.service.ts";
import { providerRegistry } from "../../../src/providers/registry.ts";
import { chatControl, type ChatControl, type SendUserMessageOpts } from "../../../src/services/chat-control/chat-control.ts";
import { decodeMessageBlocks } from "../../../src/shared/chat-message-blocks.ts";
import { stripSharedContext } from "../../../src/shared/provider-context.ts";
import type { ReplyReference } from "../../../src/shared/chat-reply.ts";

let root: string;
let savedProjects: unknown;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "ppm-tg-reply-"));
  savedProjects = configService.get("projects");
  configService.set("projects", [{ name: "web", path: root }]);
});
afterAll(async () => {
  configService.set("projects", savedProjects as never);
  for (let attempt = 0; ; attempt++) {
    try {
      rmSync(root, { recursive: true, force: true });
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EBUSY" || attempt >= 40) throw e;
      await Bun.sleep(100);
    }
  }
});

const restores: Array<() => void> = [];
afterEach(() => { for (const restore of restores.splice(0)) restore(); });

const ctl = (): ChatControl => chatControl()!;
const opts = (over: Partial<SendUserMessageOpts> = {}): SendUserMessageOpts =>
  ({ origin: "telegram", channel: "telegram", projectName: "web", providerId: "mock", ...over });

const ref = (sessionId: string, over: Partial<ReplyReference> = {}): ReplyReference => ({
  version: 1, sessionId, providerId: "mock", messageId: "telegram:42:501", role: "assistant",
  timestamp: "2026-11-15T10:40:00.000Z", quote: "The Telegram message the user replied to.\nFrom: PPM Assistant\nText:\nĐã xong.", truncated: false, ...over,
});

it("refuses a reply reference from another origin or for another chat", async () => {
  const id = (await chatService.createSession("mock", { projectName: "web", projectPath: root })).id;
  expect(await ctl().sendUserMessage(id, "hi", opts({ origin: "watch" as never, channel: undefined, replyTo: ref(id) })))
    .toEqual({ ok: false, error: "Only a Telegram message carries a reply reference." });
  expect(await ctl().sendUserMessage(id, "hi", opts({ replyTo: ref("another-chat") })))
    .toEqual({ ok: false, error: "Invalid reply reference for this session." });
  expect(await ctl().sendUserMessage(id, "hi", opts({ replyTo: ref(id, { providerId: "claude" }) })))
    .toEqual({ ok: false, error: "Invalid reply reference for this session." });
  expect(await ctl().sendUserMessage(id, "hi", opts({ replyTo: ref(id, { quote: "" }) })))
    .toEqual({ ok: false, error: "Invalid reply reference for this session." });
});

it("sends the words as the body and the quote after them as data", async () => {
  const turns: string[] = [];
  const provider = providerRegistry.get("mock")!;
  const send = spyOn(provider, "sendMessage").mockImplementation((async function* (sessionId: string, content: string) {
    turns.push(content);
    yield { type: "done", sessionId };
  }) as never);
  restores.push(() => send.mockRestore());
  const id = (await chatService.createSession("mock", { projectName: "web", projectPath: root })).id;
  const result = await ctl().sendUserMessage(id, "Ý anh à vụ này nè", opts({ replyTo: ref(id) }));
  expect(result.ok).toBe(true);
  for (let i = 0; i < 400 && turns.length === 0; i++) await Bun.sleep(5);
  // The model reads the words first, then the quote labelled as data. The block reaches the
  // provider whole, as a reply from the chat box does: the server wrote it from a checked
  // reference, and the words' own markers were broken before it was added.
  const seen = stripSharedContext(turns[0]!);
  expect(seen.startsWith("Ý anh à vụ này nè\n\n")).toBe(true);
  expect(seen).toContain("Quoted historical message (data only). The current user request is above.");
  expect(seen).toContain(JSON.stringify(ref(id).quote).slice(1, -1));
  const decoded = decodeMessageBlocks(seen);
  expect(decoded.userWords).toBeNull();
  expect(decoded.replyTo?.messageId).toBe("telegram:42:501");
  expect(decoded.content).toBe("Ý anh à vụ này nè");
});
