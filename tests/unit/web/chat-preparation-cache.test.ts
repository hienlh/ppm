import { afterEach, beforeEach, expect, it, spyOn } from "bun:test";
import { api } from "../../../src/web/lib/api-client";
import { clearChatPreparationCache, getChatPreparationSettings, getChatProviders, peekChatProviders } from "../../../src/web/lib/chat-preparation-cache";

let get: ReturnType<typeof spyOn>;
beforeEach(() => { clearChatPreparationCache(); get = spyOn(api, "get"); });
afterEach(() => { get.mockRestore(); clearChatPreparationCache(); });

it("shares requests and caches providers for 60 seconds per project", async () => {
  const list = [{ id: "codex", name: "Codex" }];
  get.mockResolvedValue(list);
  const first = getChatProviders("one");
  expect(getChatProviders("one")).toBe(first);
  expect(await first).toEqual(list);
  expect(peekChatProviders("one")).toEqual(list);
  await getChatProviders("one");
  expect(get).toHaveBeenCalledTimes(1);
  await getChatProviders("two");
  expect(get).toHaveBeenCalledTimes(2);
  const now = spyOn(Date, "now").mockReturnValue(Date.now() + 60_001);
  try {
    expect(peekChatProviders("one")).toBeUndefined();
    await getChatProviders("one");
    expect(get).toHaveBeenCalledTimes(3);
  } finally { now.mockRestore(); }
});

it("prevents an invalidated request from overwriting newer data", async () => {
  let resolve!: (value: unknown) => void;
  get.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  const old = getChatProviders("one");
  await Promise.resolve();
  clearChatPreparationCache();
  const fresh = [{ id: "claude", name: "Claude" }];
  get.mockResolvedValue(fresh);
  await getChatProviders("one");
  resolve([{ id: "codex", name: "Codex" }]);
  await old;
  expect(peekChatProviders("one")).toEqual(fresh);
});

it("gives each cache generation its own abort signal to bypass API GET sharing", async () => {
  get.mockImplementation((path: string) => Promise.resolve(path === "/api/settings/ai"
    ? { default_provider: "codex", providers: {} } : [{ id: "codex", name: "Codex" }]));
  await Promise.all([getChatPreparationSettings("one"), getChatProviders("one")]);
  clearChatPreparationCache();
  await Promise.all([getChatPreparationSettings("one"), getChatProviders("one")]);
  expect(get).toHaveBeenCalledTimes(4);
  const signals = get.mock.calls.map(([, options]) => options.signal);
  for (const signal of signals) {
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(false);
  }
  expect(new Set(signals).size).toBe(4);
});

it("does not cache failures or retain settings credentials", async () => {
  get.mockRejectedValueOnce(new Error("offline"));
  await expect(getChatProviders("one")).rejects.toThrow("offline");
  get.mockResolvedValueOnce([{ id: "codex", name: "Codex" }]);
  await expect(getChatProviders("one")).resolves.toHaveLength(1);
  get.mockResolvedValueOnce({ default_provider: "codex", providers: {
    codex: { permission_mode: "plan", api_key: "secret", system_prompt: "private" },
  } });
  expect(await getChatPreparationSettings("one")).toEqual({ default_provider: "codex",
    new_chat_provider_mode: undefined, providers: { codex: { permission_mode: "plan" } } });
});

it("bounds hanging requests and permits retry after timeout", async () => {
  const timeout = spyOn(globalThis, "setTimeout");
  let expire!: () => void;
  timeout.mockImplementation(((callback: () => void) => { expire = callback; return 0; }) as typeof setTimeout);
  try {
    get.mockImplementationOnce(() => new Promise(() => {}));
    const request = getChatProviders("one");
    await Promise.resolve();
    expect(timeout).toHaveBeenCalledWith(expect.any(Function), 30_000);
    expire();
    await expect(request).rejects.toThrow("timed out");
    get.mockResolvedValueOnce([{ id: "codex", name: "Codex" }]);
    await expect(getChatProviders("one")).resolves.toHaveLength(1);
  } finally { timeout.mockRestore(); }
});
