import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { monacoDevAsset, monacoDevAssets } from "../../../scripts/vite-monaco-dev-assets.ts";
import { MONACO_VS, isUnused } from "../../../scripts/monaco-staging.ts";

const REPO = resolve(import.meta.dir, "../../..");

describe("monacoDevAsset", () => {
  it("answers for the file the AMD loader is fetched from", () => {
    // `monaco-adapter.ts` points the loader at `/assets/monaco/vs`, so this exact request is
    // the first thing an editor tab makes under `bun dev:web`.
    const asset = monacoDevAsset("/loader.js");
    expect(asset?.file).toBe(join(MONACO_VS, "loader.js"));
    // A `text/html` answer here is the whole bug: the browser refuses the module on its MIME
    // check and the tab spins forever.
    expect(asset?.contentType).toBe("text/javascript; charset=utf-8");
  });

  it("answers for nested files and for the stylesheet", () => {
    expect(monacoDevAsset("/editor/editor.main.js")?.contentType).toBe("text/javascript; charset=utf-8");
    expect(monacoDevAsset("/editor/editor.main.css")?.contentType).toBe("text/css; charset=utf-8");
  });

  it("ignores a query string, the way the loader appends one", () => {
    expect(monacoDevAsset("/loader.js?v=1")?.file).toBe(join(MONACO_VS, "loader.js"));
  });

  it("refuses to climb out of Monaco's directory", () => {
    // The dev server listens on the LAN (`server.host: true`), so this is reachable.
    expect(monacoDevAsset("/../../package.json")).toBeNull();
    expect(monacoDevAsset("/%2e%2e/%2e%2e/package.json")).toBeNull();
    expect(monacoDevAsset("/../../../../../../etc/passwd")).toBeNull();
    expect(monacoDevAsset("/%00/loader.js")).toBeNull();
    expect(monacoDevAsset("/%zz")).toBeNull();
  });

  it("refuses the files the build does not ship, so dev cannot succeed on one", () => {
    // Both are real files in `node_modules`; `copy-monaco.ts` leaves them out of `dist/web`.
    const tsWorker = Bun.Glob ? [...new Bun.Glob("assets/ts.worker-*.js").scanSync(MONACO_VS)] : [];
    expect(tsWorker.length).toBeGreaterThan(0);
    for (const rel of tsWorker) {
      expect(isUnused(join(MONACO_VS, rel))).toBe(true);
      expect(monacoDevAsset(`/${rel.split(sep).join("/")}`)).toBeNull();
    }
    expect(monacoDevAsset("/nls.messages.ja.js.js")).toBeNull();
  });

  it("leaves anything else to Vite", () => {
    expect(monacoDevAsset("/nope.js")).toBeNull();
    expect(monacoDevAsset("/")).toBeNull(); // the directory itself is not a file
    expect(monacoDevAsset("/editor")).toBeNull();
  });
});

describe("monacoDevAssets plugin", () => {
  /** Runs `configureServer` against a connect-shaped stub and returns the middleware it mounted. */
  function mount() {
    const plugin = monacoDevAssets();
    let mountedAt: string | undefined;
    let handler: ((req: unknown, res: unknown, next: () => void) => void) | undefined;
    const configure = plugin.configureServer as (server: unknown) => void;
    configure({
      middlewares: {
        use(path: string, fn: (req: unknown, res: unknown, next: () => void) => void) {
          mountedAt = path;
          handler = fn;
        },
      },
    });
    return { plugin, mountedAt, handler: handler! };
  }

  it("mounts on the path the loader is configured with, in serve only", () => {
    const { plugin, mountedAt } = mount();
    expect(mountedAt).toBe("/assets/monaco/vs");
    // `dist/web` already holds these after `copy-monaco.ts`; serving them from `node_modules`
    // during a build would hide a staging failure.
    expect(plugin.apply).toBe("serve");
  });

  it("streams the real bytes with the right content type", async () => {
    const { handler } = mount();
    const headers: Record<string, string> = {};
    const chunks: Buffer[] = [];
    const nexted: true[] = [];
    const body = await new Promise<Buffer>((done) => {
      handler(
        { url: "/loader.js" },
        {
          setHeader: (k: string, v: string) => {
            headers[k] = v;
          },
          on() {},
          once() {},
          emit() {},
          write(chunk: Buffer) {
            chunks.push(Buffer.from(chunk));
            return true;
          },
          end(chunk?: Buffer) {
            if (chunk) chunks.push(Buffer.from(chunk));
            done(Buffer.concat(chunks));
          },
        },
        () => nexted.push(true),
      );
    });
    expect(nexted).toEqual([]);
    expect(headers["Content-Type"]).toBe("text/javascript; charset=utf-8");
    expect(body.equals(readFileSync(join(MONACO_VS, "loader.js")))).toBe(true);
  });

  it("calls next() for anything it will not serve, so the SPA fallback still runs", () => {
    const { handler } = mount();
    let nexted = 0;
    const res = { setHeader: () => {}, end: () => {} };
    handler({ url: "/../../package.json" }, res, () => nexted++);
    handler({ url: "/nope.js" }, res, () => nexted++);
    expect(nexted).toBe(2);
  });
});

describe("the two places that answer for /assets/monaco/vs", () => {
  it("are both registered", () => {
    // Without this line the dev server has no Monaco at all, which is the blocker itself.
    const config = readFileSync(join(REPO, "vite.config.ts"), "utf8");
    expect(config).toContain("monacoDevAssets()");
    expect(config).toContain("./scripts/vite-monaco-dev-assets.ts");
  });

  it("share one exclusion list, so dev cannot serve a file the build drops", () => {
    for (const file of ["scripts/copy-monaco.ts", "scripts/vite-monaco-dev-assets.ts"]) {
      const src = readFileSync(join(REPO, file), "utf8");
      expect(src).toContain("./monaco-staging.ts");
      expect(src).not.toMatch(/function isUnused/);
    }
  });

  it("no longer reference /monacoeditorwork/, which nothing has ever built", () => {
    // The AMD build loads its workers from `vs/assets/`; the worker-label map that produced
    // that path is gone, so a route and a glob-ignore for it can only mislead.
    for (const file of ["src/web/sw.ts", "vite.config.ts"]) {
      expect(readFileSync(join(REPO, file), "utf8")).not.toContain("monacoeditorwork");
    }
  });
});
