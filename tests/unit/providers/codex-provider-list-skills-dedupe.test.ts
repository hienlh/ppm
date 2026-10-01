import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { CodexAppServerProvider } from "../../../src/providers/codex-app-server/codex-provider.ts";
import { CodexJsonRpcClient } from "../../../src/providers/codex-app-server/codex-jsonrpc-client.ts";

/**
 * `/chat/prepare`'s 400ms slash budget can leave a cold skills cache still resolving when a
 * follow-up `/chat/slash-items` request lands for the same workspace — without an in-flight
 * dedupe, that second caller would start a second app-server spawn rather than joining the
 * first one already underway.
 */
describe("Codex listSkills in-flight dedupe", () => {
  const spies: Array<{ mockRestore(): void }> = [];
  let startCalls = 0;
  let skillsListCalls = 0;
  let resolveSkills!: (value: unknown) => void;

  beforeEach(() => {
    startCalls = 0;
    skillsListCalls = 0;
    spies.push(spyOn(CodexJsonRpcClient.prototype, "start").mockImplementation(() => { startCalls++; }));
    spies.push(spyOn(CodexJsonRpcClient.prototype, "notify").mockImplementation(() => {}));
    spies.push(spyOn(CodexJsonRpcClient.prototype, "close").mockImplementation(() => {}));
    spies.push(spyOn(CodexJsonRpcClient.prototype, "request").mockImplementation(async (method: string) => {
      if (method === "initialize") return {};
      if (method === "skills/list") {
        skillsListCalls++;
        // Held open deliberately: a second concurrent listSkills() call has to find this
        // one still in flight, or the test would pass even without the dedupe.
        return new Promise((resolve) => { resolveSkills = resolve; });
      }
      return {};
    }));
  });

  afterEach(() => {
    for (const spy of spies.splice(0)) spy.mockRestore();
  });

  it("two concurrent calls for the same workspace share one spawn", async () => {
    const provider = new CodexAppServerProvider();
    const first = provider.listSkills(undefined);
    const second = provider.listSkills(undefined);
    // Give both calls a turn to reach the mocked request before asserting.
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(startCalls).toBe(1);
    expect(skillsListCalls).toBe(1);

    resolveSkills({});
    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual([]);
    expect(b).toEqual([]);
  });

  it("a call after the in-flight one settles starts a fresh spawn", async () => {
    const provider = new CodexAppServerProvider();
    const first = provider.listSkills(undefined);
    await new Promise((resolve) => setTimeout(resolve, 10));
    resolveSkills({});
    await first;

    // The result came back empty, so nothing was cached (see listSkills' cache guard) — a
    // follow-up call spawns again rather than dedupe against a settled, deleted entry.
    const second = provider.listSkills(undefined);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(startCalls).toBe(2);
    resolveSkills({});
    await second;
  });
});
