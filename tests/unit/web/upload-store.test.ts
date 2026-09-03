import { describe, it, expect, beforeEach } from "bun:test";
import { useUploadStore } from "../../../src/web/components/os-explorer/upload/upload-store.ts";

function reset() {
  useUploadStore.setState({ order: [], batches: {}, cancellers: {} });
}

describe("upload-store", () => {
  beforeEach(reset);

  it("addBatch seeds every item as queued with zero bytes loaded", () => {
    useUploadStore.getState().addBatch("b1", "/dst", [
      { id: "0", name: "a.txt", relativePath: "a.txt", size: 100 },
      { id: "1", name: "b.txt", relativePath: "b.txt", size: 200 },
    ]);
    const batch = useUploadStore.getState().batches.b1!;
    expect(batch.items.map((i) => i.state)).toEqual(["queued", "queued"]);
    expect(batch.items.every((i) => i.bytesLoaded === 0)).toBe(true);
    expect(batch.settled).toBe(false);
  });

  it("setItemProgress only touches the targeted item's bytesLoaded", () => {
    useUploadStore.getState().addBatch("b1", "/dst", [
      { id: "0", name: "a.txt", relativePath: "a.txt", size: 100 },
      { id: "1", name: "b.txt", relativePath: "b.txt", size: 200 },
    ]);
    useUploadStore.getState().setItemProgress("b1", "0", 50);
    const items = useUploadStore.getState().batches.b1!.items;
    expect(items.find((i) => i.id === "0")?.bytesLoaded).toBe(50);
    expect(items.find((i) => i.id === "1")?.bytesLoaded).toBe(0);
  });

  it("batch becomes settled only once every item leaves queued/uploading", () => {
    useUploadStore.getState().addBatch("b1", "/dst", [
      { id: "0", name: "a.txt", relativePath: "a.txt", size: 100 },
      { id: "1", name: "b.txt", relativePath: "b.txt", size: 200 },
    ]);
    useUploadStore.getState().setItemState("b1", "0", "done");
    expect(useUploadStore.getState().batches.b1!.settled).toBe(false);
    useUploadStore.getState().setItemState("b1", "1", "failed", "Not allowed here");
    const batch = useUploadStore.getState().batches.b1!;
    expect(batch.settled).toBe(true);
    expect(batch.items.find((i) => i.id === "1")?.errorMessage).toBe("Not allowed here");
  });

  it("cancelItem invokes only the registered canceller for that item", () => {
    useUploadStore.getState().addBatch("b1", "/dst", [
      { id: "0", name: "a.txt", relativePath: "a.txt", size: 100 },
      { id: "1", name: "b.txt", relativePath: "b.txt", size: 200 },
    ]);
    let cancelledA = false;
    let cancelledB = false;
    useUploadStore.getState().registerCanceller("b1", "0", () => { cancelledA = true; });
    useUploadStore.getState().registerCanceller("b1", "1", () => { cancelledB = true; });
    useUploadStore.getState().cancelItem("b1", "0");
    expect(cancelledA).toBe(true);
    expect(cancelledB).toBe(false);
  });

  it("cancelBatch invokes every item's canceller", () => {
    useUploadStore.getState().addBatch("b1", "/dst", [
      { id: "0", name: "a.txt", relativePath: "a.txt", size: 100 },
      { id: "1", name: "b.txt", relativePath: "b.txt", size: 200 },
    ]);
    const cancelled: string[] = [];
    useUploadStore.getState().registerCanceller("b1", "0", () => cancelled.push("0"));
    useUploadStore.getState().registerCanceller("b1", "1", () => cancelled.push("1"));
    useUploadStore.getState().cancelBatch("b1");
    expect(cancelled.sort()).toEqual(["0", "1"]);
  });

  it("dismissBatch removes the batch and its order entry", () => {
    useUploadStore.getState().addBatch("b1", "/dst", [{ id: "0", name: "a.txt", relativePath: "a.txt", size: 1 }]);
    useUploadStore.getState().dismissBatch("b1");
    expect(useUploadStore.getState().batches.b1).toBeUndefined();
    expect(useUploadStore.getState().order).toEqual([]);
  });
});
