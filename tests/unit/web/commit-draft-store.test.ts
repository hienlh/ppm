import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { api } from "../../../src/web/lib/api-client";
import { COMMIT_DRAFT_CLIENT_ID, useCommitDraftStore } from "../../../src/web/stores/commit-draft-store";

const URL = "/api/project/demo/git/commit-draft";
const spies: { mockRestore(): void }[] = [];
const store = () => useCommitDraftStore.getState();

function stubGet(message: string, gate?: Promise<void>) {
  const spy = spyOn(api, "get").mockImplementation((async () => {
    await gate;
    return { message, updatedAt: null };
  }) as typeof api.get);
  spies.push(spy);
  return spy;
}

function stubPut(gate?: Promise<void>) {
  const spy = spyOn(api, "put").mockImplementation((async () => { await gate; return {}; }) as typeof api.put);
  spies.push(spy);
  return spy;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

afterEach(() => {
  for (const s of spies.splice(0)) s.mockRestore();
  store().consumed(URL, store().drafts[URL]?.message ?? "");
  useCommitDraftStore.setState({ drafts: {} });
});

describe("commit-draft-store", () => {
  it("saves 300 ms after the last keystroke, once, with this page's id", async () => {
    const put = stubPut();
    store().edit(URL, "f");
    store().edit(URL, "fi");
    store().edit(URL, "fix");
    expect(put).not.toHaveBeenCalled();
    await Bun.sleep(380);
    expect(put).toHaveBeenCalledTimes(1);
    expect(put.mock.calls[0]).toEqual([URL, { message: "fix", clientId: COMMIT_DRAFT_CLIENT_ID }]);
    expect(store().drafts[URL]).toMatchObject({ message: "fix", dirty: false });
  });

  it("does not read a change from elsewhere over an unsaved edit", async () => {
    stubPut(new Promise(() => {}));
    const get = stubGet("theirs");
    store().edit(URL, "mine");
    await store().refresh(URL);
    expect(get).not.toHaveBeenCalled();
    expect(store().drafts[URL]?.message).toBe("mine");
  });

  it("keeps typing that started while the first read was in flight", async () => {
    const gate = deferred();
    stubGet("saved", gate.promise);
    stubPut(new Promise(() => {}));
    const loading = store().load(URL);
    store().edit(URL, "typed");
    gate.resolve();
    await loading;
    expect(store().drafts[URL]?.message).toBe("typed");
  });

  it("a commit drops the pending save of the message it used", async () => {
    const put = stubPut();
    store().edit(URL, "feat: thing\n");
    store().consumed(URL, "feat: thing");
    await Bun.sleep(380);
    expect(put).not.toHaveBeenCalled();
    expect(store().drafts[URL]).toMatchObject({ message: "", dirty: false });
  });

  it("a commit leaves what was typed while it ran, and saves it", async () => {
    const put = stubPut();
    store().edit(URL, "feat: thing, and the next one");
    store().consumed(URL, "feat: thing");
    await Bun.sleep(380);
    expect(put.mock.calls[0]).toEqual([URL, { message: "feat: thing, and the next one", clientId: COMMIT_DRAFT_CLIENT_ID }]);
    expect(store().drafts[URL]).toMatchObject({ message: "feat: thing, and the next one", dirty: false });
  });

  it("stays unsaved when the save failed, so a change from elsewhere is not read over it", async () => {
    spies.push(spyOn(api, "put").mockRejectedValue(new Error("offline")));
    const get = stubGet("older, from the server");
    store().edit(URL, "typed");
    await expect(store().flush(URL)).rejects.toThrow("offline");
    expect(store().drafts[URL]).toMatchObject({ message: "typed", dirty: true });
    await store().refresh(URL);
    expect(get).not.toHaveBeenCalled();
    expect(store().drafts[URL]?.message).toBe("typed");
  });

  it("stays unsaved when more was typed during the save", async () => {
    const gate = deferred();
    stubPut(gate.promise);
    store().edit(URL, "a");
    const saving = store().flush(URL);
    store().edit(URL, "ab");
    gate.resolve();
    await saving;
    expect(store().drafts[URL]).toMatchObject({ message: "ab", dirty: true });
  });

  it("waits for a save already on the wire before saving again, so the last text wins", async () => {
    const first = deferred();
    const order: string[] = [];
    const spy = spyOn(api, "put").mockImplementation((async (_url: string, body: { message: string }) => {
      if (body.message === "a") await first.promise;
      order.push(body.message);
      return {};
    }) as typeof api.put);
    spies.push(spy);
    store().edit(URL, "a");
    const one = store().flush(URL);
    store().edit(URL, "ab");
    const two = store().flush(URL);
    first.resolve();
    await Promise.all([one, two]);
    expect(order).toEqual(["a", "ab"]);
    expect(store().drafts[URL]).toMatchObject({ message: "ab", dirty: false });
  });
});
