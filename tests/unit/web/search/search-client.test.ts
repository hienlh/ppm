/**
 * The search client turns a project's search state into requests: debounced while typing (query
 * and, while the replace field is open, the replace text), one AbortController per search, the
 * older search aborted before a newer one goes out (1.5), and `POST /files/replace`.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import {
  createSearchClient,
  searchUrl,
  SEARCH_DEBOUNCE_MS,
} from "../../../../src/web/lib/search/search-client.ts";
import { useSearchStore, getSearchState, defaultSearchState } from "../../../../src/web/stores/search-store.ts";
import type { SearchResponse, ReplaceReport } from "../../../../src/services/content-search/search-options.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function responseFor(query: string): SearchResponse {
  return {
    results: [{ file: `${query}.ts`, matches: [{ line: 1, column: 0, length: query.length, before: "", cutBefore: false, text: query, after: "" }] }],
    total: 1,
    files: 1,
    limitHit: false,
    engine: "rg",
  };
}

interface Call { url: string; init: RequestInit }

/** A fetch whose answers the test hands out by hand; an abort rejects the pending one. */
function fakeFetch() {
  const calls: Call[] = [];
  const pending: Array<{ resolve: (r: Response) => void; signal?: AbortSignal | null }> = [];
  const fn = ((input: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    return new Promise<Response>((resolve, reject) => {
      const signal = init.signal;
      if (signal?.aborted) return reject(new DOMException("Aborted", "AbortError"));
      const entry = { resolve, signal };
      signal?.addEventListener("abort", () => {
        // An aborted request is over: `answer()` must reach the next live one, not this.
        pending.splice(pending.indexOf(entry), 1);
        reject(new DOMException("Aborted", "AbortError"));
      }, { once: true });
      pending.push(entry);
    });
  }) as typeof fetch;
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  return {
    fn,
    calls,
    /** Answer the oldest unanswered request. */
    answer(body: unknown, status = 200) {
      const next = pending.shift();
      if (!next) throw new Error("no pending request");
      next.resolve(json(body, status));
    },
    answerAt(index: number, body: unknown, status = 200) {
      pending[index]!.resolve(json(body, status));
    },
  };
}

const tick = () => sleep(0);

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("ppm-auth-token", "tok");
  useSearchStore.setState({ projects: {}, history: {}, viewMode: "list" });
});

describe("searchUrl", () => {
  it("is null for an empty query", () => {
    expect(searchUrl("ppm", { ...defaultSearchState(), query: "" })).toBeNull();
  });

  it("carries the query, the options and the filters", () => {
    const url = searchUrl("my proj", {
      ...defaultSearchState(),
      query: "a b",
      caseSensitive: true,
      wholeWord: true,
      regex: true,
      include: "src/**, *.ts",
      exclude: "dist",
      useIgnore: false,
    })!;
    const [path, qs] = url.split("?");
    expect(path).toBe("/api/project/my%20proj/files/search");
    const p = new URLSearchParams(qs);
    expect(p.get("q")).toBe("a b");
    expect(p.get("caseSensitive")).toBe("true");
    expect(p.get("wholeWord")).toBe("true");
    expect(p.get("regex")).toBe("true");
    expect(p.get("include")).toBe("src/**, *.ts");
    expect(p.get("exclude")).toBe("dist");
    expect(p.get("useIgnore")).toBe("false");
    expect(p.has("replace")).toBe(false);
  });

  it("leaves out empty filters, and sends the replace text only while the replace field is open", () => {
    const base = { ...defaultSearchState(), query: "x", replace: "y", preserveCase: true };
    const closed = new URLSearchParams(searchUrl("ppm", { ...base, showReplace: false })!.split("?")[1]);
    expect(closed.has("include")).toBe(false);
    expect(closed.has("exclude")).toBe(false);
    expect(closed.get("useIgnore")).toBe("true");
    expect(closed.has("replace")).toBe(false);
    expect(closed.has("preserveCase")).toBe(false);

    const open = new URLSearchParams(searchUrl("ppm", { ...base, showReplace: true })!.split("?")[1]);
    expect(open.get("replace")).toBe("y");
    expect(open.get("preserveCase")).toBe("true");

    // An empty replace text in an open field is still a replacement: the matches are deleted.
    const empty = new URLSearchParams(searchUrl("ppm", { ...base, replace: "", showReplace: true })!.split("?")[1]);
    expect(empty.get("replace")).toBe("");
  });

  it("sends the query and the replace text byte for byte: URL characters, regex syntax and edge spaces", () => {
    // A leading/trailing space is part of what the user searches for, as in VS Code.
    const query = " a&b=c#d+e%f? (\\d+)$ ";
    const replace = "$1 & #2+%";
    const url = searchUrl("ppm", { ...defaultSearchState(), query, regex: true, replace, showReplace: true })!;
    expect(url.includes("#")).toBe(false);
    const p = new URLSearchParams(url.split("?")[1]);
    expect(p.get("q")).toBe(query);
    expect(p.get("replace")).toBe(replace);
  });
});

describe("searching", () => {
  it("debounces typing into one request with the latest query", async () => {
    expect(SEARCH_DEBOUNCE_MS).toBe(300);
    const f = fakeFetch();
    const client = createSearchClient({ fetch: f.fn, debounceMs: 20 });
    const { update } = useSearchStore.getState();

    update("ppm", { query: "f" });
    client.schedule("ppm");
    update("ppm", { query: "fo" });
    client.schedule("ppm");
    update("ppm", { query: "foo" });
    client.schedule("ppm");
    expect(getSearchState("ppm").status).toBe("searching");
    await sleep(5);
    expect(f.calls.length).toBe(0);
    await sleep(40);
    expect(f.calls.length).toBe(1);
    expect(new URLSearchParams(f.calls[0]!.url.split("?")[1]).get("q")).toBe("foo");
    expect(new Headers(f.calls[0]!.init.headers).get("Authorization")).toBe("Bearer tok");
  });

  it("debounces changes to the replace text while the replace field is open", async () => {
    const f = fakeFetch();
    const client = createSearchClient({ fetch: f.fn, debounceMs: 20 });
    const { update } = useSearchStore.getState();
    update("ppm", { query: "foo", showReplace: true });
    for (const r of ["b", "ba", "bar"]) { update("ppm", { replace: r }); client.schedule("ppm"); }
    await sleep(40);
    expect(f.calls.length).toBe(1);
    expect(new URLSearchParams(f.calls[0]!.url.split("?")[1]).get("replace")).toBe("bar");
  });

  it("stores the answer, resets dismissed and collapsed rows, and adds the query to the history", async () => {
    const f = fakeFetch();
    const client = createSearchClient({ fetch: f.fn, debounceMs: 0 });
    useSearchStore.getState().update("ppm", { query: "foo", dismissed: new Set(["x:1:0"]), collapsed: new Set(["x"]) });
    const done = client.searchNow("ppm");
    await tick();
    f.answer({ ok: true, data: responseFor("foo") });
    await done;

    const s = getSearchState("ppm");
    expect(s.status).toBe("done");
    expect(s.response).toEqual(responseFor("foo"));
    expect(s.error).toBeNull();
    expect(s.dismissed.size).toBe(0);
    expect(s.collapsed.size).toBe(0);
    expect(useSearchStore.getState().historyOf("ppm")).toEqual(["foo"]);
  });

  it("accepts the response bytes without an envelope", async () => {
    const f = fakeFetch();
    const client = createSearchClient({ fetch: f.fn });
    useSearchStore.getState().update("ppm", { query: "foo" });
    const done = client.searchNow("ppm");
    await tick();
    f.answer(responseFor("foo"));
    await done;
    expect(getSearchState("ppm").response).toEqual(responseFor("foo"));
  });

  it("aborts the older search before sending a newer one, and never shows the older answer", async () => {
    const f = fakeFetch();
    const client = createSearchClient({ fetch: f.fn });
    const { update } = useSearchStore.getState();

    update("ppm", { query: "old" });
    const first = client.searchNow("ppm");
    await tick();
    const firstSignal = f.calls[0]!.init.signal!;

    update("ppm", { query: "new" });
    const second = client.searchNow("ppm");
    await tick();
    expect(firstSignal.aborted).toBe(true);
    const secondSignal = f.calls[1]!.init.signal!;
    expect(secondSignal).not.toBe(firstSignal);
    expect(secondSignal.aborted).toBe(false);

    f.answer(responseFor("new"));
    await Promise.all([first, second]);
    const s = getSearchState("ppm");
    expect(s.response).toEqual(responseFor("new"));
    expect(s.status).toBe("done");
  });

  it("searches of different projects do not abort each other", async () => {
    const f = fakeFetch();
    const client = createSearchClient({ fetch: f.fn });
    const { update } = useSearchStore.getState();
    update("a", { query: "foo" });
    update("b", { query: "foo" });
    const pa = client.searchNow("a");
    const pb = client.searchNow("b");
    await tick();
    expect(f.calls[0]!.init.signal!.aborted).toBe(false);
    f.answerAt(0, responseFor("a"));
    f.answerAt(1, responseFor("b"));
    await Promise.all([pa, pb]);
    expect(getSearchState("a").response).toEqual(responseFor("a"));
    expect(getSearchState("b").response).toEqual(responseFor("b"));
  });

  it("an empty query aborts the running search and empties the list without a request", async () => {
    const f = fakeFetch();
    const client = createSearchClient({ fetch: f.fn, debounceMs: 10 });
    const { update } = useSearchStore.getState();
    update("ppm", { query: "foo", response: responseFor("foo"), status: "done" });
    const running = client.searchNow("ppm");
    await tick();

    update("ppm", { query: "" });
    client.schedule("ppm");
    expect(f.calls[0]!.init.signal!.aborted).toBe(true);
    await running;
    await sleep(30);
    expect(f.calls.length).toBe(1);
    const s = getSearchState("ppm");
    expect(s.response).toBeNull();
    expect(s.status).toBe("idle");
  });

  it("cancel aborts the search and leaves the panel idle", async () => {
    const f = fakeFetch();
    const client = createSearchClient({ fetch: f.fn, debounceMs: 10 });
    useSearchStore.getState().update("ppm", { query: "foo" });
    const running = client.searchNow("ppm");
    await tick();
    client.cancel("ppm");
    await running;
    expect(f.calls[0]!.init.signal!.aborted).toBe(true);
    expect(getSearchState("ppm").status).toBe("idle");

    client.schedule("ppm");
    client.cancel("ppm");
    await sleep(30);
    expect(f.calls.length).toBe(1);
  });

  it("reports the engine's error with its status, and shows no results", async () => {
    const f = fakeFetch();
    const client = createSearchClient({ fetch: f.fn });
    useSearchStore.getState().update("ppm", { query: "(", regex: true, response: responseFor("x") });
    const done = client.searchNow("ppm");
    await tick();
    f.answer({ ok: false, error: "regex parse error: unclosed group" }, 400);
    await done;
    const s = getSearchState("ppm");
    expect(s.status).toBe("error");
    expect(s.error).toEqual({ message: "regex parse error: unclosed group", status: 400 });
    expect(s.response).toBeNull();
    expect(useSearchStore.getState().historyOf("ppm")).toEqual([]);
  });

  it("reports a request that never reached the server", async () => {
    const client = createSearchClient({ fetch: (() => Promise.reject(new TypeError("Failed to fetch"))) as unknown as typeof fetch });
    useSearchStore.getState().update("ppm", { query: "foo" });
    await client.searchNow("ppm");
    expect(getSearchState("ppm").status).toBe("error");
    expect(getSearchState("ppm").error).toEqual({ message: "Failed to fetch", status: 0 });
  });

  it("warmUp sends an empty search and changes nothing in the store", async () => {
    const f = fakeFetch();
    const client = createSearchClient({ fetch: f.fn });
    useSearchStore.getState().update("ppm", { query: "kept", response: responseFor("kept"), status: "done" });
    client.warmUp("ppm");
    await tick();
    expect(f.calls.length).toBe(1);
    const p = new URLSearchParams(f.calls[0]!.url.split("?")[1]);
    expect(f.calls[0]!.url.startsWith("/api/project/ppm/files/search?")).toBe(true);
    expect(p.get("q")).toBe("");
    f.answer({ results: [], total: 0 });
    await tick();
    expect(getSearchState("ppm")).toMatchObject({ query: "kept", status: "done" });
    expect(getSearchState("ppm").response).toEqual(responseFor("kept"));
  });
});

describe("replace", () => {
  const files = [{ file: "a.ts", matches: [{ line: 1, column: 0, text: "foo", replacement: "bar" }] }];
  const report: ReplaceReport = { replaced: 1, files: 1, skipped: [], failed: [] };

  it("posts the listed matches to /files/replace and returns the report", async () => {
    const f = fakeFetch();
    const client = createSearchClient({ fetch: f.fn });
    const done = client.replace("ppm", files);
    await tick();
    expect(f.calls[0]!.url).toBe("/api/project/ppm/files/replace");
    expect(f.calls[0]!.init.method).toBe("POST");
    expect(JSON.parse(String(f.calls[0]!.init.body))).toEqual({ files });
    expect(new Headers(f.calls[0]!.init.headers).get("Authorization")).toBe("Bearer tok");
    f.answer({ ok: true, data: report });
    expect(await done).toEqual(report);
  });

  it("throws the server's reason when the replace is refused", async () => {
    const f = fakeFetch();
    const client = createSearchClient({ fetch: f.fn });
    const done = client.replace("ppm", files);
    await tick();
    f.answer({ ok: false, error: "Search could not start: spawn failed" }, 503);
    await expect(done).rejects.toMatchObject({ message: "Search could not start: spawn failed", status: 503 });
  });
});
