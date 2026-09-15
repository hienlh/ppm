import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockProvider } from "../../../src/providers/mock-provider.ts";
import { providerRegistry } from "../../../src/providers/registry.ts";
import { chatService } from "../../../src/services/chat.service.ts";
import { configService } from "../../../src/services/config.service.ts";
import type { ChatEvent, SendMessageOpts } from "../../../src/types/chat.ts";

test("common send path shares by default, respects opt-out and commands, and supports new providers", async () => {
  const project = mkdtempSync(join(tmpdir(), "ppm-chat-sharing-"));
  const original = configService.get("ai");
  class CaptureProvider extends MockProvider {
    id = "sharing-test";
    supportsSharedContext = true;
    nextEvent: ChatEvent | undefined;
    calls: Array<{ message: string; opts?: SendMessageOpts }> = [];
    pushMessage(_id: string, message: string, opts?: SendMessageOpts) {
      this.calls.push({ message, opts });
    }
    async *sendMessage(_id: string, message: string, opts?: SendMessageOpts): AsyncIterable<ChatEvent> {
      this.calls.push({ message, opts });
      yield { type: "text", content: "ok" };
      if (this.nextEvent) { const event = this.nextEvent; this.nextEvent = undefined; yield event; }
    }
  }
  const provider = new CaptureProvider();
  providerRegistry.register(provider);
  const session = await provider.createSession({});
  session.projectPath = project;
  const send = async (message: string) => {
    for await (const _ of chatService.sendMessage(provider.id, session.id, message)) { /* drain */ }
    return provider.calls.at(-1)!;
  };
  try {
    writeFileSync(join(project, "CLAUDE.md"), "SHARED_PROJECT_SENTINEL");
    configService.set("ai", { ...original, share_provider_context: undefined });
    const enabled = await send("hello");
    expect(enabled.message).toBe("hello");
    expect(enabled.opts?.sharedContext).toContain("SHARED_PROJECT_SENTINEL");
    expect((await send("unchanged follow up")).opts?.sharedContext).toBeUndefined();
    await chatService.pushMessage(provider.id, session.id, "unchanged live follow up");
    expect(provider.calls.at(-1)?.opts?.sharedContext).toBeUndefined();
    provider.nextEvent = { type: "system", subtype: "compact_done" };
    await send("trigger compaction");
    expect((await send("after compaction")).opts?.sharedContext).toContain("SHARED_PROJECT_SENTINEL");
    provider.nextEvent = { type: "error", message: "transport failed" };
    await send("failed turn");
    expect((await send("retry")).opts?.sharedContext).toContain("SHARED_PROJECT_SENTINEL");
    writeFileSync(join(project, "CLAUDE.md"), "UPDATED_SHARED_FACT");
    await chatService.pushMessage(provider.id, session.id, "follow up");
    expect(provider.calls.at(-1)?.message).toBe("follow up");
    expect(provider.calls.at(-1)?.opts?.sharedContext).toContain("UPDATED_SHARED_FACT");
    configService.set("ai", { ...original, share_provider_context: false });
    expect((await send("hello")).opts?.sharedContext).toBeUndefined();
    await chatService.pushMessage(provider.id, session.id, "disabled follow up");
    expect(provider.calls.at(-1)?.opts?.sharedContext).toBeUndefined();
    configService.set("ai", { ...original, share_provider_context: true });
    expect((await send("/compact")).opts?.sharedContext).toBeUndefined();
    provider.supportsSharedContext = false;
    const fallback = await send("hello");
    expect(fallback.message).toContain("UPDATED_SHARED_FACT");
    expect(fallback.message.endsWith("\n\nhello")).toBe(true);
    expect(fallback.opts?.sharedContext).toBeUndefined();
    session.projectPath = undefined;
    expect((await send("hello")).message).toBe("hello");
  } finally {
    configService.set("ai", original);
    await provider.deleteSession(session.id);
    rmSync(project, { recursive: true, force: true });
  }
});
