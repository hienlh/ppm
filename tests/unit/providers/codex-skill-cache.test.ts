import { afterEach, expect, it, spyOn } from "bun:test";
import { CodexAppServerProvider } from "../../../src/providers/codex-app-server/codex-provider";
import { CodexJsonRpcClient } from "../../../src/providers/codex-app-server/codex-jsonrpc-client";

const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => spies.splice(0).forEach((spy) => spy.mockRestore()));

it("refresh discovers an installed skill without waiting for the provider TTL", async () => {
  let installed = false;
  spies.push(spyOn(CodexJsonRpcClient.prototype, "start").mockImplementation(() => {}));
  spies.push(spyOn(CodexJsonRpcClient.prototype, "notify").mockImplementation(() => {}));
  spies.push(spyOn(CodexJsonRpcClient.prototype, "close").mockImplementation(() => {}));
  spies.push(spyOn(CodexJsonRpcClient.prototype, "request").mockImplementation(async (method) =>
    method === "skills/list" ? { data: [{ skills: [{ name: installed ? "ak-cook" : "skill-installer" }] }] } : {}));
  const provider = new CodexAppServerProvider();
  expect((await provider.listSkills())[0]?.name).toBe("skill-installer");
  installed = true;
  expect((await provider.listSkills())[0]?.name).toBe("skill-installer");
  provider.invalidateSkillsCache();
  expect((await provider.listSkills())[0]?.name).toBe("ak-cook");
});
