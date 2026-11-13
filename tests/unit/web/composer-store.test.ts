import { describe, it, expect, beforeEach } from "bun:test";
import { useExtensionStore } from "../../../src/web/stores/extension-store.ts";

function reset() {
  useExtensionStore.setState({ composer: null });
}

describe("extension-store composer slice", () => {
  beforeEach(reset);

  it("resolveComposer settles the promise and clears the dialog", async () => {
    const pending = useExtensionStore.getState().showComposer("req1", {});
    expect(useExtensionStore.getState().composer?.requestId).toBe("req1");

    useExtensionStore.getState().resolveComposer("req1", {
      content: "hi",
      permissionMode: "bypassPermissions",
    });

    expect(await pending).toEqual({ content: "hi", permissionMode: "bypassPermissions" });
    expect(useExtensionStore.getState().composer).toBeNull();
  });

  it("resolveComposer with a mismatched requestId is a no-op", async () => {
    useExtensionStore.getState().showComposer("req1", {});
    useExtensionStore.getState().resolveComposer("some-other-req", {
      content: "hi",
      permissionMode: "bypassPermissions",
    });
    // Dialog for req1 is still open — the mismatched call touched nothing
    expect(useExtensionStore.getState().composer?.requestId).toBe("req1");
  });

  it("dismissComposer closes the dialog WITHOUT resolving the promise", async () => {
    const pending = useExtensionStore.getState().showComposer("req1", {});
    let settled = false;
    pending.then(() => { settled = true; });

    useExtensionStore.getState().dismissComposer("req1");
    expect(useExtensionStore.getState().composer).toBeNull();

    // Give any microtask a chance to run — the promise must still be pending
    await new Promise((r) => setTimeout(r, 0));
    expect(settled).toBe(false);
  });

  it("dismissComposer with a mismatched requestId is a no-op", () => {
    useExtensionStore.getState().showComposer("req1", {});
    useExtensionStore.getState().dismissComposer("some-other-req");
    expect(useExtensionStore.getState().composer?.requestId).toBe("req1");
  });

  it("showComposer resolves any previously pending composer with undefined (leak guard)", async () => {
    const first = useExtensionStore.getState().showComposer("req1", {});
    useExtensionStore.getState().showComposer("req2", {});
    expect(await first).toBeUndefined();
    expect(useExtensionStore.getState().composer?.requestId).toBe("req2");
  });
});
