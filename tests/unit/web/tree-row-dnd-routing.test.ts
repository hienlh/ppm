import { describe, it, expect } from "bun:test";
import { isSameProjectLegacyPayload } from "../../../src/web/components/explorer/use-tree-row-dnd.ts";
import type { EntryDragPayload } from "../../../src/web/components/os-explorer/dnd/entry-drag-payload.ts";

const treePayload = (projectName: string): EntryDragPayload => ({
  paths: ["/projects/demo/some/file.txt"],
  origin: "tree",
  projectName,
});

describe("isSameProjectLegacyPayload", () => {
  it("accepts a tree-origin drag whose projectName matches this row's project", () => {
    expect(isSameProjectLegacyPayload(treePayload("demo"), true, "demo")).toBe(true);
  });

  it("rejects a tree-origin drag from a DIFFERENT project — the cross-project bug", () => {
    // Two panels, two active projects: project A's tree drags onto project B's tree. Both
    // dual-write the same legacy MIME, so its mere presence must not be enough — the legacy
    // project-scoped move would otherwise resolve A's relative path against B's root.
    expect(isSameProjectLegacyPayload(treePayload("project-a"), true, "project-b")).toBe(false);
  });

  it("rejects when the legacy MIME is not actually present on this drag", () => {
    expect(isSameProjectLegacyPayload(treePayload("demo"), false, "demo")).toBe(false);
  });

  it("rejects an explorer-origin payload even if projectName happens to match", () => {
    const payload: EntryDragPayload = { paths: ["/x/y.txt"], origin: "explorer", projectName: "demo" };
    expect(isSameProjectLegacyPayload(payload, true, "demo")).toBe(false);
  });

  it("rejects a null payload (foreign drag, or in-flight ref unavailable)", () => {
    expect(isSameProjectLegacyPayload(null, true, "demo")).toBe(false);
  });

  it("rejects a tree payload with no projectName at all", () => {
    const payload: EntryDragPayload = { paths: ["/x/y.txt"], origin: "tree" };
    expect(isSameProjectLegacyPayload(payload, true, "demo")).toBe(false);
  });
});
