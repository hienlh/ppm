/**
 * Global upload progress state — batches of in-flight uploads (a drop or a picker pick), each
 * with per-file rows. Backs the persistent upload panel that replaced the old
 * "Uploading N files… NN%" toast, which had no room for per-file outcomes or a cancel button.
 *
 * Cancel hooks are kept in a side map (`cancellers`), not on the serializable item/batch
 * state — an `AbortController.abort` closure has no business living next to plain data a
 * test might snapshot or log.
 */

import { create } from "zustand";

export type UploadItemState = "queued" | "uploading" | "done" | "skipped" | "failed" | "cancelled";

export interface UploadItem {
  id: string;
  name: string;
  relativePath: string;
  size: number;
  bytesLoaded: number;
  state: UploadItemState;
  errorMessage?: string;
}

export interface UploadBatch {
  id: string;
  dstDir: string;
  items: UploadItem[];
  /** True once every item has left "queued"/"uploading" — the panel swaps Cancel for Close. */
  settled: boolean;
}

type NewUploadItem = Pick<UploadItem, "id" | "name" | "relativePath" | "size">;

function deriveSettled(items: UploadItem[]): boolean {
  return items.every((i) => i.state !== "queued" && i.state !== "uploading");
}

interface UploadStoreState {
  order: string[];
  batches: Record<string, UploadBatch>;
  cancellers: Record<string, () => void>;

  addBatch(id: string, dstDir: string, items: NewUploadItem[]): void;
  registerCanceller(batchId: string, itemId: string, cancel: () => void): void;
  setItemState(batchId: string, itemId: string, state: UploadItemState, errorMessage?: string): void;
  setItemProgress(batchId: string, itemId: string, bytesLoaded: number): void;
  cancelItem(batchId: string, itemId: string): void;
  cancelBatch(batchId: string): void;
  dismissBatch(batchId: string): void;
}

export const useUploadStore = create<UploadStoreState>((set, get) => ({
  order: [],
  batches: {},
  cancellers: {},

  addBatch: (id, dstDir, items) => {
    const batch: UploadBatch = {
      id,
      dstDir,
      items: items.map((item) => ({ ...item, bytesLoaded: 0, state: "queued" })),
      settled: false,
    };
    set((s) => ({ order: [...s.order, id], batches: { ...s.batches, [id]: batch } }));
  },

  registerCanceller: (batchId, itemId, cancel) => {
    set((s) => ({ cancellers: { ...s.cancellers, [`${batchId}:${itemId}`]: cancel } }));
  },

  setItemState: (batchId, itemId, state, errorMessage) => {
    set((s) => {
      const batch = s.batches[batchId];
      if (!batch) return s;
      const items = batch.items.map((i) => (i.id === itemId ? { ...i, state, errorMessage } : i));
      return { batches: { ...s.batches, [batchId]: { ...batch, items, settled: deriveSettled(items) } } };
    });
  },

  setItemProgress: (batchId, itemId, bytesLoaded) => {
    set((s) => {
      const batch = s.batches[batchId];
      if (!batch) return s;
      const items = batch.items.map((i) => (i.id === itemId ? { ...i, bytesLoaded } : i));
      return { batches: { ...s.batches, [batchId]: { ...batch, items } } };
    });
  },

  // Cancelling only ever *asks* the in-flight job to stop (abort the XHR, or skip a queued
  // job before it starts) — the resulting "cancelled" state is set by the job itself once its
  // promise actually rejects, not here, so state and reality never disagree.
  cancelItem: (batchId, itemId) => {
    get().cancellers[`${batchId}:${itemId}`]?.();
  },

  cancelBatch: (batchId) => {
    const batch = get().batches[batchId];
    if (!batch) return;
    for (const item of batch.items) get().cancelItem(batchId, item.id);
  },

  dismissBatch: (batchId) => {
    set((s) => {
      const { [batchId]: _removed, ...batches } = s.batches;
      return { batches, order: s.order.filter((id) => id !== batchId) };
    });
  },
}));
