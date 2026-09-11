/**
 * Expanding a folder in the file explorer, and what the prefetch is worth.
 *
 * The tree loads one directory level at a time, and an idle prefetch fetches the
 * children of every subfolder a level ahead so the next click renders from
 * memory. That only pays off if clicking a folder whose prefetch is still in
 * flight *waits for it*. It used to abort it and issue an identical request
 * instead — same URL, same response, nothing to preempt — so the click paid the
 * whole round trip over again, and on a server whose event loop stalls that is
 * seconds of spinner for data that was already on its way.
 *
 * `api.get` cannot save this either: it dedupes concurrent GETs of one URL, but
 * only for callers that pass no `AbortSignal`, and every one of these passes one.
 */
import { describe, it, expect, mock, beforeEach } from "bun:test";

/** One controllable response per URL, so a test can hold a request open. */
const pending: { url: string; resolve: (v: unknown) => void; aborted: boolean }[] = [];
let getCalls: string[] = [];

mock.module("/home/thawngho/Projects/ppm/src/web/lib/api-client.ts", () => ({
  projectUrl: (name: string) => `/api/projects/${name}`,
  api: {
    get: (url: string, opts?: { signal?: AbortSignal }) => {
      getCalls.push(url);
      return new Promise((resolve, reject) => {
        const entry = { url, resolve: resolve as (v: unknown) => void, aborted: false };
        opts?.signal?.addEventListener("abort", () => {
          entry.aborted = true;
          const e = new Error("Aborted");
          e.name = "AbortError";
          reject(e);
        });
        pending.push(entry);
      });
    },
    post: () => Promise.resolve([]),
  },
}));

const { useFileStore } = await import("/home/thawngho/Projects/ppm/src/web/stores/file-store.ts");

const FOLDER = "src/app/notification-campaigns";

beforeEach(() => {
  pending.length = 0;
  getCalls = [];
  useFileStore.setState({
    tree: [{ name: "notification-campaigns", path: FOLDER, type: "directory" }],
    loadedPaths: new Set<string>(),
    inflight: new Map(),
  });
});

describe("clicking a folder whose prefetch is already in flight", () => {
  it("waits for that request instead of aborting and starting another", async () => {
    const store = useFileStore.getState();

    store.loadChildren("p", FOLDER, { prefetch: true });
    await Promise.resolve();
    expect(getCalls).toHaveLength(1); // the prefetch is away

    // The user clicks the folder before it lands.
    const click = store.loadChildren("p", FOLDER);
    await Promise.resolve();

    expect(pending[0]!.aborted).toBe(false); // its own answer must not be thrown away
    expect(getCalls).toHaveLength(1); // and no second request for the same path

    pending[0]!.resolve([{ name: "dto", type: "directory" }]);
    await click;

    expect(useFileStore.getState().loadedPaths.has(FOLDER)).toBe(true);
  });

  it("still resolves the click when the request it waited on fails", async () => {
    const store = useFileStore.getState();
    store.loadChildren("p", FOLDER, { prefetch: true });
    await Promise.resolve();

    const click = store.loadChildren("p", FOLDER);
    await Promise.resolve();
    pending[0]!.resolve([]);
    await click; // must not hang or throw

    expect(useFileStore.getState().loadedPaths.has(FOLDER)).toBe(true);
  });
});
