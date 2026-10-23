import { describe, it, expect, beforeEach } from "bun:test";
import { useExtensionStore } from "../../../src/web/stores/extension-store.ts";

/** Whether a promise has settled by the next macrotask. */
async function settled(promise: Promise<unknown>): Promise<boolean> {
  let done = false;
  promise.then(() => { done = true; });
  await new Promise((r) => setTimeout(r, 0));
  return done;
}

describe("extension-store quick pick and input box dismiss", () => {
  beforeEach(() => useExtensionStore.setState({ quickPick: null, inputBox: null }));

  it("dismissQuickPick closes the dialog it names WITHOUT resolving it, so no answer is sent", async () => {
    const pending = useExtensionStore.getState().showQuickPick("req1", [{ label: "a" }]);
    expect(useExtensionStore.getState().quickPick?.requestId).toBe("req1");
    useExtensionStore.getState().dismissQuickPick("req1");
    expect(useExtensionStore.getState().quickPick).toBeNull();
    expect(await settled(pending)).toBe(false);
  });

  it("dismissQuickPick for another request leaves the open dialog alone", () => {
    useExtensionStore.getState().showQuickPick("req1", [{ label: "a" }]);
    useExtensionStore.getState().dismissQuickPick("req2");
    expect(useExtensionStore.getState().quickPick?.requestId).toBe("req1");
  });

  it("dismissInputBox closes the dialog it names WITHOUT resolving it", async () => {
    const pending = useExtensionStore.getState().showInputBox("req1", { prompt: "name" });
    useExtensionStore.getState().dismissInputBox("req1");
    expect(useExtensionStore.getState().inputBox).toBeNull();
    expect(await settled(pending)).toBe(false);
  });

  it("dismissInputBox for another request leaves the open dialog alone", () => {
    useExtensionStore.getState().showInputBox("req1");
    useExtensionStore.getState().dismissInputBox("req2");
    expect(useExtensionStore.getState().inputBox?.requestId).toBe("req1");
  });

  it("an answered dialog still resolves with the answer", async () => {
    const pending = useExtensionStore.getState().showInputBox("req1");
    useExtensionStore.getState().resolveInputBox("typed");
    expect(await pending).toBe("typed");
    expect(useExtensionStore.getState().inputBox).toBeNull();
  });
});
