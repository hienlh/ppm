/**
 * The chat tab's metadata writes merge into what the store holds *now*. They used to spread
 * the component's `metadata` prop — a snapshot from its last render — which silently undid
 * anything another writer (the design tab hosting the chat, the panel store) had written in
 * between.
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { installDom, uninstallDom } from "../../helpers/react-dom";

installDom();
afterAll(uninstallDom);
const { usePanelStore } = await import("../../../src/web/stores/panel-store");
const { mergeTabMetadata, patchTabMetadata } = await import("../../../src/web/lib/patch-tab-metadata");

beforeEach(() => {
  usePanelStore.setState({
    currentProject: "p", focusedPanelId: "main", grid: [["main"]],
    panels: { main: { id: "main", activeTabId: "design:d", tabHistory: [], tabs: [{
      id: "design:d", type: "design", title: "D", projectId: "p", closable: true,
      metadata: { projectName: "p", designSlug: "d", permissionMode: "acceptEdits" },
    }] } },
  } as never);
});

const meta = () => usePanelStore.getState().panels.main!.tabs[0]!.metadata!;

describe("patchTabMetadata", () => {
  it("keeps a concurrent write that the writer's snapshot never saw", () => {
    const staleProp = { ...meta() }; // what the chat rendered with
    // Another writer lands after that render: the design tab bumps its chat epoch.
    patchTabMetadata("design:d", { designChatEpoch: 4, designSessionChecked: true });
    // The chat's persist effect then fires with its (stale) prop in scope.
    void staleProp;
    patchTabMetadata("design:d", { sessionId: "s1", providerId: "claude", pickedAccountId: undefined });
    expect(meta()).toMatchObject({
      designSlug: "d", permissionMode: "acceptEdits", designChatEpoch: 4, designSessionChecked: true,
      sessionId: "s1", providerId: "claude",
    });
    expect(meta().pickedAccountId).toBeUndefined();
  });

  it("does nothing for a tab that is gone", () => {
    patchTabMetadata("missing", { sessionId: "x" });
    expect(meta().sessionId).toBeUndefined();
  });

  it("lets the patch win key by key", () => {
    expect(mergeTabMetadata({ a: 1, b: 2 }, { b: 3, c: undefined })).toEqual({ a: 1, b: 3, c: undefined });
    expect(mergeTabMetadata(undefined, { a: 1 })).toEqual({ a: 1 });
  });
});

describe("chat-tab metadata writes", () => {
  it("never spreads the metadata prop back into the store", () => {
    const src = readFileSync(resolve(import.meta.dir, "../../../src/web/components/chat/chat-tab.tsx"), "utf8");
    expect(src).not.toMatch(/\.\.\.metadata\b/);
    expect(src).toContain("patchTabMetadata(tabId, {");
  });
});
