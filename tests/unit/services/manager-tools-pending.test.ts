/**
 * A manager chat's tools come with its stream's MCP servers, which are fixed when the stream
 * starts. Settings says "Manager tools arrive the next time this chat starts" exactly while the
 * chat's live stream predates its assignment, and never for a chat with no live stream.
 */
import { afterEach, expect, it, spyOn } from "bun:test";
import "../../test-setup.ts";
import { providerRegistry } from "../../../src/providers/registry.ts";
import { managerToolsPending } from "../../../src/services/assistant-managers/manager-chats-announce.ts";

const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); });

function liveSince(startedAt: Record<string, number>) {
  spies.push(spyOn(providerRegistry, "get").mockReturnValue({
    liveStreamStartedAt: (id: string) => startedAt[id] ?? null,
  } as never));
}

it("is true only while the live stream started before the assignment", () => {
  liveSince({ old: 1_000, fresh: 5_000 });
  expect(managerToolsPending("old", "claude", 2_000)).toBe(true);
  expect(managerToolsPending("fresh", "claude", 2_000)).toBe(false);
  expect(managerToolsPending("closed", "claude", 2_000)).toBe(false);
});

it("is false for a provider that cannot say when its stream started", () => {
  const get = spyOn(providerRegistry, "get").mockReturnValue({} as never);
  spies.push(get);
  expect(managerToolsPending("any", "claude", 2_000)).toBe(false);
  get.mockReturnValue(undefined as never);
  expect(managerToolsPending("any", "claude", 2_000)).toBe(false);
});
