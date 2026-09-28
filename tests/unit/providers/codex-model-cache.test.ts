import { afterEach, expect, it, spyOn } from "bun:test";
import { CodexAppServerProvider } from "../../../src/providers/codex-app-server/codex-provider";
import { CodexJsonRpcClient } from "../../../src/providers/codex-app-server/codex-jsonrpc-client";

const spies: { mockRestore(): void }[] = [];
afterEach(() => { for (const spy of spies.splice(0)) spy.mockRestore(); });

it("shares cold model discovery and serves cached models during a refresh", async () => {
  const start = spyOn(CodexJsonRpcClient.prototype, "start").mockImplementation(() => {});
  spies.push(start, spyOn(CodexJsonRpcClient.prototype, "notify").mockImplementation(() => {}),
    spyOn(CodexJsonRpcClient.prototype, "close").mockImplementation(() => {}));
  let resolve!: (value: unknown) => void;
  let response = new Promise((yes) => { resolve = yes; });
  spies.push(spyOn(CodexJsonRpcClient.prototype, "request").mockImplementation((async (method: string) =>
    method === "model/list" ? response : {}) as CodexJsonRpcClient["request"]));
  const provider = new CodexAppServerProvider();
  const first = provider.listModels();
  const second = provider.listModels();
  resolve({ data: [{ id: "gpt-test", model: "gpt-test", displayName: "GPT Test" }], nextCursor: null });
  const models = await first;
  expect(models.length).toBe(1);
  expect(await second).toEqual(models);
  expect(start).toHaveBeenCalledTimes(1);
  expect(await provider.listModels()).toEqual(models);
  expect(start).toHaveBeenCalledTimes(1);
  const now = Date.now();
  spies.push(spyOn(Date, "now").mockReturnValue(now + 6 * 60 * 1000));
  response = new Promise((yes) => { resolve = yes; });
  // These return the existing list without waiting for the unresolved refresh.
  expect(await provider.listModels()).toEqual(models);
  expect(await provider.listModels()).toEqual(models);
  resolve({ data: [{ id: "gpt-new", model: "gpt-new", displayName: "GPT New" }], nextCursor: null });
  await new Promise((yes) => setTimeout(yes, 0));
  expect(start).toHaveBeenCalledTimes(2);
  expect((await provider.listModels())[0]?.value).toBe("gpt-new");
});
