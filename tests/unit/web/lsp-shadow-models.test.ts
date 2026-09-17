/**
 * The models that make F12 and peek work across files, and the three ways they did not.
 *
 * Standalone Monaco has no public way to register a model *resolver*, so a provider about to
 * return "the definition is in other.ts" has to create a model for it first. They are capped,
 * because the contents of every file ever referenced would otherwise accumulate for the life
 * of the page — and the cap is where this went wrong.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import type * as MonacoType from "monaco-editor";
import { api } from "../../../src/web/lib/api-client.ts";
import { ensureShadowModels, disposeShadowModels } from "../../../src/web/lib/lsp/lsp-shadow-models.ts";

const MAX_SHADOW_MODELS = 40; // mirrors the module; not exported, and not worth exporting
const MAX_FETCH_ATTEMPTS = 3; // likewise

/** A Monaco whose models are plain objects, so a test can see which were disposed. */
function fakeMonaco() {
  const models = new Map<string, { uri: string; disposed: boolean; isDisposed(): boolean; dispose(): void }>();
  const monaco = {
    Uri: { parse: (uri: string) => ({ toString: () => uri, uri }) },
    editor: {
      getModel: (parsed: { uri: string }) => models.get(parsed.uri) ?? null,
      createModel: (_content: string, _language: undefined, parsed: { uri: string }) => {
        const model = {
          uri: parsed.uri,
          disposed: false,
          isDisposed() { return this.disposed; },
          dispose() { this.disposed = true; },
        };
        models.set(parsed.uri, model);
        return model;
      },
    },
  } as unknown as typeof MonacoType;
  return { monaco, models, alive: () => [...models.values()].filter((m) => !m.disposed).map((m) => m.uri) };
}

const realGet = api.get.bind(api);
let requested: string[] = [];

beforeEach(() => {
  requested = [];
  disposeShadowModels();
  (api as unknown as { get: unknown }).get = async (path: string) => {
    requested.push(path);
    return { content: "// contents\n" };
  };
});

afterEach(() => {
  disposeShadowModels();
  (api as unknown as { get: unknown }).get = realGet;
});

const uris = (root: string, from: number, count: number) =>
  Array.from({ length: count }, (_, i) => `file://${root}/f${from + i}.ts`);

describe("ensureShadowModels", () => {
  it("keeps every model it just created, even past the cap", async () => {
    // Find-all-references on a widely used symbol asks for every location at once. Evicting
    // inside the creation loop disposed the batch's own earliest models before the provider
    // had returned them, so peek opened empty for exactly the results that made the list long.
    const { monaco, alive } = fakeMonaco();
    const batch = uris("/p", 0, MAX_SHADOW_MODELS + 15);

    await ensureShadowModels(monaco, "demo", "/p", batch);

    expect(alive().sort()).toEqual([...batch].sort());
  });

  it("evicts the oldest once a later call has room to", async () => {
    const { monaco, models } = fakeMonaco();
    await ensureShadowModels(monaco, "demo", "/p", uris("/p", 0, MAX_SHADOW_MODELS));

    await ensureShadowModels(monaco, "demo", "/p", uris("/p", 100, 3));

    expect(models.get("file:///p/f0.ts")?.disposed).toBe(true);
    expect(models.get("file:///p/f2.ts")?.disposed).toBe(true);
    expect(models.get("file:///p/f3.ts")?.disposed).toBe(false);
    expect(models.get("file:///p/f100.ts")?.disposed).toBe(false);
  });

  it("counts a file that is asked for again as recently used", async () => {
    // A file peeked at all afternoon is the oldest key otherwise, and the first thing thrown
    // away — which is the opposite of what a cache of forty is for.
    const { monaco, models } = fakeMonaco();
    await ensureShadowModels(monaco, "demo", "/p", uris("/p", 0, MAX_SHADOW_MODELS));

    await ensureShadowModels(monaco, "demo", "/p", ["file:///p/f0.ts"]);
    await ensureShadowModels(monaco, "demo", "/p", ["file:///p/f100.ts"]);

    expect(models.get("file:///p/f0.ts")?.disposed).toBe(false);
    expect(models.get("file:///p/f1.ts")?.disposed).toBe(true);
  });

  it("re-creates a model something else disposed", async () => {
    const { monaco, models } = fakeMonaco();
    await ensureShadowModels(monaco, "demo", "/p", ["file:///p/a.ts"]);
    models.get("file:///p/a.ts")!.dispose();
    models.delete("file:///p/a.ts");

    await ensureShadowModels(monaco, "demo", "/p", ["file:///p/a.ts"]);

    expect(models.get("file:///p/a.ts")?.disposed).toBe(false);
  });

  it("does not refetch a file it already has a model for", async () => {
    const { monaco } = fakeMonaco();
    await ensureShadowModels(monaco, "demo", "/p", ["file:///p/a.ts"]);
    const after = requested.length;

    await ensureShadowModels(monaco, "demo", "/p", ["file:///p/a.ts"]);

    expect(requested).toHaveLength(after);
  });
});

describe("paths, and which of them are inside the project", () => {
  it("resolves a Windows location whose drive letter is lower-cased", async () => {
    // This is the whole of go-to-definition-across-files on Windows: a language server
    // answers `file:///c%3A/...` while the project is configured as `C:\…`, so a
    // case-sensitive compare called every location external and created no model at all.
    const { monaco, alive } = fakeMonaco();

    await ensureShadowModels(monaco, "demo", "C:\\Users\\dev\\proj", ["file:///c%3A/Users/dev/proj/src/a.ts"]);

    expect(alive()).toEqual(["file:///c%3A/Users/dev/proj/src/a.ts"]);
    // The path sent to the host keeps its own casing; only the project prefix is relaxed.
    expect(requested[0]).toContain(encodeURIComponent("src/a.ts"));
  });

  it("still compares a POSIX path exactly", async () => {
    // Two names differing only in case are two different files there, so relaxing it would
    // read one file and claim it is another.
    const { monaco, alive } = fakeMonaco();

    await ensureShadowModels(monaco, "demo", "/home/dev/proj", ["file:///home/dev/Proj/a.ts"]);

    expect(alive()).toEqual([]);
    expect(requested).toEqual([]);
  });

  it("ignores a location outside the project", async () => {
    const { monaco, alive } = fakeMonaco();

    await ensureShadowModels(monaco, "demo", "/p", ["file:///usr/lib/node_modules/x/index.d.ts"]);

    expect(alive()).toEqual([]);
  });
});

describe("the negative cache", () => {
  it("does not retry a miss", async () => {
    const { monaco } = fakeMonaco();
    await ensureShadowModels(monaco, "demo", "/p", ["file:///elsewhere/a.ts"]);
    await ensureShadowModels(monaco, "demo", "/p", ["file:///elsewhere/a.ts"]);

    expect(requested).toEqual([]);
  });

  it("is bounded, so following types through a dependency tree cannot grow it forever", async () => {
    // Every location the host cannot produce lands here and nothing ever removed one: a
    // session spent following types through a dependency tree reaches thousands of strings
    // that are never read again.
    const { monaco } = fakeMonaco();
    (api as unknown as { get: unknown }).get = async (path: string) => {
      requested.push(path);
      return {}; // the host has no such file
    };
    const first = "file:///p/gone.ts";

    for (let i = 0; i < MAX_FETCH_ATTEMPTS; i++) await ensureShadowModels(monaco, "demo", "/p", [first]);
    requested = [];
    await ensureShadowModels(monaco, "demo", "/p", [first]);
    expect(requested).toEqual([]); // given up on, so not asked for again

    await ensureShadowModels(
      monaco, "demo", "/p",
      Array.from({ length: 600 }, (_, i) => `file:///p/later-${i}.ts`),
    );
    requested = [];

    // The oldest entry has been forgotten, so the next mention is asked for again...
    await ensureShadowModels(monaco, "demo", "/p", [first]);
    expect(requested).toEqual([expect.stringContaining(encodeURIComponent("gone.ts"))]);

    // ...whereas a recent one is still remembered, which is what the cache is for.
    const recent = "file:///p/later-599.ts";
    for (let i = 0; i < MAX_FETCH_ATTEMPTS; i++) await ensureShadowModels(monaco, "demo", "/p", [recent]);
    requested = [];
    await ensureShadowModels(monaco, "demo", "/p", [recent]);
    expect(requested).toEqual([]);
  });

  it("recovers from a failure that was only transient", async () => {
    // A 500, a dropped socket or a tunnel that blinked arrive in the same `catch` as a file
    // that is genuinely absent, and `api.get` throws a bare `Error` either way. Giving up on
    // the first one disabled go-to-definition into that file for the life of the page — for a
    // blip that was over before the user tried again.
    const { monaco, alive } = fakeMonaco();
    let failuresLeft = 1;
    (api as unknown as { get: unknown }).get = async (path: string) => {
      requested.push(path);
      if (failuresLeft-- > 0) throw new Error("Server error (HTTP 500)");
      return { content: "// contents\n" };
    };

    await ensureShadowModels(monaco, "demo", "/p", ["file:///p/blip.ts"]);
    expect(alive()).toEqual([]);

    await ensureShadowModels(monaco, "demo", "/p", ["file:///p/blip.ts"]);
    expect(alive()).toEqual(["file:///p/blip.ts"]);
  });

  it("stops asking once a file has failed often enough to mean it", async () => {
    const { monaco } = fakeMonaco();
    (api as unknown as { get: unknown }).get = async (path: string) => {
      requested.push(path);
      throw new Error("Server error (HTTP 500)");
    };

    for (let i = 0; i < MAX_FETCH_ATTEMPTS + 4; i++) {
      await ensureShadowModels(monaco, "demo", "/p", ["file:///p/never.ts"]);
    }

    expect(requested).toHaveLength(MAX_FETCH_ATTEMPTS);
  });

  it("forgets the failures of a file that later answers", async () => {
    // Otherwise a file that blinked twice is one blip away from being given up on for good,
    // however long it has been serving fine since.
    const { monaco, models } = fakeMonaco();
    const uri = "file:///p/flaky.ts";
    let failNext = true;
    (api as unknown as { get: unknown }).get = async (path: string) => {
      requested.push(path);
      if (failNext) throw new Error("Server error (HTTP 500)");
      return { content: "// contents\n" };
    };

    await ensureShadowModels(monaco, "demo", "/p", [uri]); // blip
    await ensureShadowModels(monaco, "demo", "/p", [uri]); // blip
    failNext = false;
    await ensureShadowModels(monaco, "demo", "/p", [uri]); // and then it answers
    expect(models.get(uri)?.disposed).toBe(false);

    // Evicted later, so the file has to be fetched again — and it is flaky again. Had the two
    // earlier blips still counted, this would give up after a single attempt.
    models.get(uri)!.dispose();
    models.delete(uri);
    requested = [];
    failNext = true;
    for (let i = 0; i < MAX_FETCH_ATTEMPTS; i++) {
      await ensureShadowModels(monaco, "demo", "/p", [uri]);
    }
    expect(requested).toHaveLength(MAX_FETCH_ATTEMPTS);
  });
});

describe("how many files it fetches at once", () => {
  it("never has more than a handful in flight", async () => {
    // Find-all-references over a widely used symbol arrives as hundreds of locations, and one
    // request each is a burst the server answers slowly and the browser queues anyway.
    const { monaco } = fakeMonaco();
    let inFlight = 0;
    let peak = 0;
    (api as unknown as { get: unknown }).get = async (path: string) => {
      requested.push(path);
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight--;
      return { content: "// contents\n" };
    };

    await ensureShadowModels(monaco, "demo", "/p", uris("/p", 0, 60));

    expect(requested).toHaveLength(60); // all of them still fetched...
    expect(peak).toBeLessThanOrEqual(6); // ...just not all at once
  });
});

describe("disposeShadowModels", () => {
  it("disposes everything it created", async () => {
    const { monaco, alive } = fakeMonaco();
    await ensureShadowModels(monaco, "demo", "/p", uris("/p", 0, 5));

    disposeShadowModels();

    expect(alive()).toEqual([]);
  });

  it("is what the last editor closing calls", () => {
    // Exported and never called is how forty files' contents stayed in memory until the page
    // reloaded; `releaseLspConnection` answers whether that release was the last one.
    const src = require("node:fs").readFileSync(
      require("node:path").resolve(import.meta.dir, "../../../src/web/hooks/use-lsp.ts"),
      "utf8",
    );
    expect(src).toContain("if (releaseLspConnection(projectName)) disposeShadowModels();");
  });
});
