/**
 * The boot watchdog in `index.html` is the one reporter that runs when the bundle never did,
 * and it is inline JavaScript no bundler or type checker ever sees — a typo there disables it
 * silently. So the script is taken out of the real file and run against stub globals: a boot
 * that failed must post one `entry_never_ran` row with keepalive, a boot that worked none.
 */
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const html = readFileSync(resolve(import.meta.dir, "../../../src/web/index.html"), "utf8");
const watchdog = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
  .map((m) => m[1]!)
  .find((body) => body.includes("ppm:boot-retry"))!;

function boot(opts: { entryRan: boolean; retried?: boolean; token?: string | null }) {
  const local = new Map<string, string>();
  if (opts.token) local.set("ppm-auth-token", opts.token);
  const session = new Map<string, string>();
  if (opts.retried) session.set("ppm:boot-retry", "1");
  const posts: Array<{ url: string; init: RequestInit }> = [];
  const listeners: Record<string, () => void> = {};
  const root = { innerHTML: "" };
  const win: Record<string, unknown> = {
    __ppmEntryRan: opts.entryRan,
    addEventListener: (type: string, fn: () => void) => { listeners[type] = fn; },
  };
  const env = {
    window: win,
    localStorage: { getItem: (k: string) => local.get(k) ?? null, setItem: (k: string, v: string) => { local.set(k, v); } },
    sessionStorage: {
      getItem: (k: string) => session.get(k) ?? null,
      setItem: (k: string, v: string) => { session.set(k, v); },
      removeItem: (k: string) => { session.delete(k); },
    },
    performance: { getEntriesByType: () => [{ name: "http://ppm.test/assets/index-abc.js", responseStatus: 404 }, { name: "http://ppm.test/", responseStatus: 200 }] },
    fetch: (url: string, init: RequestInit) => { posts.push({ url, init }); return Promise.resolve({ status: 200 }); },
    crypto: { getRandomValues: (b: Uint8Array) => { b.fill(7); return b; } },
    location: { origin: "http://ppm.test", pathname: "/project/x", reload: () => {} },
    navigator: { userAgent: "test-agent" },
    document: { getElementById: () => root },
    caches: undefined,
    setTimeout: (fn: () => void) => fn(),
  };
  // eslint-disable-next-line no-new-func
  new Function(...Object.keys(env), watchdog)(...Object.values(env));
  listeners.load!();
  return { posts, local };
}

describe("boot watchdog beacon", () => {
  it("posts one entry_never_ran row, keepalive, naming the files that failed to load", () => {
    const { posts, local } = boot({ entryRan: false, token: "tok" });
    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toBe("/api/trace");
    expect(posts[0]!.init.keepalive).toBe(true);
    expect((posts[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    const body = JSON.parse(posts[0]!.init.body as string);
    // Minted in the same format device-id.ts accepts, and remembered for the bundle.
    expect(body.deviceId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(local.get("ppm-device-id")).toBe(body.deviceId);
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0].type).toBe("entry_never_ran");
    expect(body.entries[0].payload).toEqual({ path: "/project/x", retried: false, failed: ["/assets/index-abc.js 404"], ua: "test-agent" });
  });

  it("says when the silent reload already happened", () => {
    const { posts } = boot({ entryRan: false, retried: true });
    expect(JSON.parse(posts[0]!.init.body as string).entries[0].payload.retried).toBe(true);
  });

  it("stays silent when the entry ran", () => {
    expect(boot({ entryRan: true }).posts).toEqual([]);
  });
});
