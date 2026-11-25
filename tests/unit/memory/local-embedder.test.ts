/**
 * The local embedder against fake hosts: a script written to a temp install dir that speaks the
 * same JSON-lines protocol and returns fixed vectors. The real model is never loaded; the real
 * host source is run against a fake `@huggingface/transformers` package in the install dir.
 */
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EMBED_BATCH_SIZE,
  LOCAL_EMBED_DTYPE,
  LOCAL_EMBED_MODEL,
  applyE5Prefix,
  isE5Model,
} from "../../../src/services/memory/embedding/embedder.ts";
import { EMBED_HOST_FILE, EMBED_HOST_SOURCE } from "../../../src/services/memory/embedding/embed-host-source.ts";
import {
  LOCAL_IDLE_MS,
  LOCAL_MAX_RESTARTS,
  LOCAL_RESTART_WINDOW_MS,
  LocalEmbedder,
} from "../../../src/services/memory/embedding/local-embedder.ts";
import { resolveBunPath } from "../../../src/services/autostart-generator.ts";

let root = "";
const open: LocalEmbedder[] = [];

beforeAll(() => {
  if (!process.env.PPM_HOME) process.env.PPM_HOME = mkdtempSync(join(tmpdir(), "ppm-local-embedder-home-"));
  root = mkdtempSync(join(tmpdir(), "ppm-local-embedder-"));
});

afterEach(async () => {
  await Promise.all(open.splice(0).map((e) => e.close()));
});

function make(opts: ConstructorParameters<typeof LocalEmbedder>[0]): LocalEmbedder {
  const e = new LocalEmbedder(opts);
  open.push(e);
  return e;
}

let dirSeq = 0;
function newInstallDir(): string {
  const dir = join(root, `install-${++dirSeq}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * A fake host. Logs each start (pid + cwd) to starts.log and each request to requests.log in its
 * own folder. mode "ok": vector = [text length, last char code, 1]; a text containing FAIL gets
 * an error line. mode "crash": exits with code 1 on the first request.
 */
function writeFakeHost(dir: string, mode: "ok" | "crash" = "ok"): void {
  const src = `
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const MODE = ${JSON.stringify(mode)};
appendFileSync(join(here, "starts.log"), JSON.stringify({ pid: process.pid, cwd: process.cwd() }) + "\\n");
process.stdout.write("this line is not protocol and must be ignored\\n");
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const req = JSON.parse(line);
  appendFileSync(join(here, "requests.log"), JSON.stringify(req) + "\\n");
  if (MODE === "crash") process.exit(1);
  if (req.texts.some((t) => t.includes("FAIL"))) return out({ id: req.id, error: "model exploded" });
  out({ id: req.id, vectors: req.texts.map((t) => [t.length, t.charCodeAt(t.length - 1), 1]) });
});
rl.on("close", () => process.exit(0));
`;
  writeFileSync(join(dir, EMBED_HOST_FILE), src);
}

function starts(dir: string): Array<{ pid: number; cwd: string }> {
  const f = join(dir, "starts.log");
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function requests(dir: string): Array<{ id: unknown; texts: string[]; kind: string }> {
  const f = join(dir, "requests.log");
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(cond: () => boolean, ms = 3_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await Bun.sleep(20);
  }
  return cond();
}

const fail = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (x: Error) => x,
  );

describe("embedder basics", () => {
  test("constants", () => {
    expect(EMBED_BATCH_SIZE).toBe(16);
    expect(LOCAL_EMBED_MODEL).toBe("Xenova/multilingual-e5-small");
    expect(LOCAL_EMBED_DTYPE).toBe("q8");
    expect(LOCAL_IDLE_MS).toBe(10 * 60_000);
    expect(LOCAL_MAX_RESTARTS).toBe(3);
    expect(LOCAL_RESTART_WINDOW_MS).toBe(10 * 60_000);
  });

  test("e5 models are recognised by name", () => {
    expect(isE5Model("Xenova/multilingual-e5-small")).toBe(true);
    expect(isE5Model("intfloat/e5-large-v2")).toBe(true);
    expect(isE5Model("text-embedding-3-small")).toBe(false);
    expect(isE5Model("nomic-embed-text")).toBe(false);
  });

  test("e5 prefixes: query: / passage:, nothing for other models", () => {
    expect(applyE5Prefix(["a", "b"], "query", "Xenova/multilingual-e5-small")).toEqual(["query: a", "query: b"]);
    expect(applyE5Prefix(["a"], "passage", "Xenova/multilingual-e5-small")).toEqual(["passage: a"]);
    expect(applyE5Prefix(["a"], "query", "text-embedding-3-small")).toEqual(["a"]);
  });
});

describe("LocalEmbedder with a fake host", () => {
  test("model id carries the source, model and dtype", () => {
    const e = make({ installDir: newInstallDir() });
    expect(e.model).toBe("local:Xenova/multilingual-e5-small@q8");
  });

  test("starts nothing until asked, then one host from the install dir, reused", async () => {
    const dir = newInstallDir();
    writeFakeHost(dir);
    const e = make({ installDir: dir });
    await Bun.sleep(50);
    expect(starts(dir)).toHaveLength(0);
    expect(e.pid).toBeNull();

    const v = await e.embed(["hello"], "passage");
    expect(v).toHaveLength(1);
    expect(v[0]).toBeInstanceOf(Float32Array);
    // texts reach the host already prefixed: "passage: hello"
    expect(Array.from(v[0])).toEqual(["passage: hello".length, "o".charCodeAt(0), 1]);

    await e.embed(["again"], "query");
    const s = starts(dir);
    expect(s).toHaveLength(1);
    expect(realpathSync(s[0].cwd)).toBe(realpathSync(dir));
    expect(e.pid).toBe(s[0].pid);
    expect(e.status().available).toBe(true);
  });

  test("protocol: one JSON line per batch with id, prefixed texts and kind", async () => {
    const dir = newInstallDir();
    writeFakeHost(dir);
    const e = make({ installDir: dir });
    await e.embed(["tìm cái này"], "query");
    await e.embed(["một đoạn"], "passage");
    const r = requests(dir);
    expect(r).toHaveLength(2);
    expect(r[0].texts).toEqual(["query: tìm cái này"]);
    expect(r[0].kind).toBe("query");
    expect(r[1].texts).toEqual(["passage: một đoạn"]);
    expect(r[1].kind).toBe("passage");
    expect(r[0].id).not.toBe(r[1].id);
  });

  test("batches of 16, vectors back in input order", async () => {
    const dir = newInstallDir();
    writeFakeHost(dir);
    const e = make({ installDir: dir });
    const texts = Array.from({ length: 40 }, (_, i) => "x".repeat(i + 1));
    const out = await e.embed(texts, "passage");
    expect(requests(dir).map((r) => r.texts.length)).toEqual([16, 16, 8]);
    expect(out).toHaveLength(40);
    out.forEach((v, i) => expect(v[0]).toBe("passage: ".length + i + 1));
  });

  test("concurrent calls are answered by id", async () => {
    const dir = newInstallDir();
    writeFakeHost(dir);
    const e = make({ installDir: dir });
    const [a, b] = await Promise.all([e.embed(["aa"], "passage"), e.embed(["bbbbbb"], "passage")]);
    expect(a[0][0]).toBe("passage: aa".length);
    expect(b[0][0]).toBe("passage: bbbbbb".length);
    expect(starts(dir)).toHaveLength(1);
  });

  test("an error line rejects that call with the host's message; the host stays up", async () => {
    const dir = newInstallDir();
    writeFakeHost(dir);
    const e = make({ installDir: dir });
    await e.embed(["warm"], "passage");
    const pid = e.pid!;
    const err = await fail(e.embed(["FAIL here"], "passage"));
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain("model exploded");
    expect(e.pid).toBe(pid);
    expect((await e.embed(["ok"], "passage"))[0][0]).toBe("passage: ok".length);
    expect(starts(dir)).toHaveLength(1);
  });

  test("exits after the idle timeout and starts again on the next call, without counting a crash", async () => {
    const dir = newInstallDir();
    writeFakeHost(dir);
    const e = make({ installDir: dir, idleMs: 150, maxRestarts: 0 });
    await e.embed(["one"], "passage");
    const pid = e.pid!;
    expect(alive(pid)).toBe(true);

    expect(await waitFor(() => !alive(pid))).toBe(true);
    expect(e.pid).toBeNull();

    // maxRestarts 0: an idle exit counted as a crash would make this call fail
    await e.embed(["two"], "passage");
    expect(starts(dir)).toHaveLength(2);
    expect(e.status().available).toBe(true);
  });

  test("a host that keeps crashing is restarted at most 3 times, then reported unavailable", async () => {
    const dir = newInstallDir();
    writeFakeHost(dir, "crash");
    const e = make({ installDir: dir });

    for (let i = 0; i < 4; i++) {
      const err = await fail(e.embed(["boom " + i], "passage"));
      expect(err).toBeInstanceOf(Error);
    }
    // first start + 3 restarts
    expect(starts(dir)).toHaveLength(4);

    const err = await fail(e.embed(["again"], "passage"));
    expect(err!.message).toMatch(/unavailable/i);
    expect(starts(dir)).toHaveLength(4);
    expect(e.status().available).toBe(false);
    expect(e.status().reason).toMatch(/unavailable/i);

    // Sync now / a settings change resets it
    writeFakeHost(dir, "ok");
    e.reset();
    expect(e.status().available).toBe(true);
    expect((await e.embed(["fine"], "passage"))[0][0]).toBe("passage: fine".length);
    expect(starts(dir)).toHaveLength(5);
  });

  test("crashes outside the restart window do not add up", async () => {
    const dir = newInstallDir();
    writeFakeHost(dir, "crash");
    const e = make({ installDir: dir, maxRestarts: 1, restartWindowMs: 100 });
    for (let i = 0; i < 4; i++) {
      expect(await fail(e.embed(["boom"], "passage"))).toBeInstanceOf(Error);
      await Bun.sleep(150);
    }
    expect(starts(dir)).toHaveLength(4);
    expect(e.status().available).toBe(true);
  });

  test("no host file → not installed, nothing spawned", async () => {
    const dir = newInstallDir();
    const e = make({ installDir: dir });
    const err = await fail(e.embed(["a"], "passage"));
    expect(err!.message).toMatch(/not installed/i);
    expect(e.pid).toBeNull();
    expect(e.status().available).toBe(false);
    expect(e.status().reason).toMatch(/not installed/i);
  });

  test("an empty list starts nothing", async () => {
    const dir = newInstallDir();
    writeFakeHost(dir);
    const e = make({ installDir: dir });
    expect(await e.embed([], "passage")).toEqual([]);
    expect(starts(dir)).toHaveLength(0);
  });

  test("close() stops the host it started", async () => {
    const dir = newInstallDir();
    writeFakeHost(dir);
    const e = make({ installDir: dir });
    await e.embed(["a"], "passage");
    const pid = e.pid!;
    await e.close();
    expect(await waitFor(() => !alive(pid))).toBe(true);
    expect(e.pid).toBeNull();
  });
});

describe("the real host source against a fake @huggingface/transformers", () => {
  function installFakeTransformers(dir: string): void {
    const pkg = join(dir, "node_modules", "@huggingface", "transformers");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(
      join(pkg, "package.json"),
      JSON.stringify({ name: "@huggingface/transformers", version: "0.0.0-fake", type: "module", main: "index.mjs", exports: "./index.mjs" }),
    );
    writeFileSync(
      join(pkg, "index.mjs"),
      `
import { appendFileSync } from "node:fs";
const log = new URL("./calls.log", import.meta.url);
export const env = {};
export async function pipeline(task, model, opts) {
  appendFileSync(log, JSON.stringify({ task, model, dtype: opts && opts.dtype, cacheDir: env.cacheDir }) + "\\n");
  return async (texts, o) => ({
    tolist: () => texts.map((t) => [t.length, o && o.pooling === "mean" ? 1 : 0, o && o.normalize ? 1 : 0]),
  });
}
`,
    );
  }

  function calls(dir: string): any[] {
    const f = join(dir, "node_modules", "@huggingface", "transformers", "calls.log");
    if (!existsSync(f)) return [];
    return readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  }

  test("the host source is a non-empty ES module importing @huggingface/transformers", () => {
    expect(EMBED_HOST_FILE).toBe("embed-host.mjs");
    expect(EMBED_HOST_SOURCE.length).toBeGreaterThan(100);
    const scan = new Bun.Transpiler({ loader: "js" }).scan(EMBED_HOST_SOURCE);
    expect(scan.imports.map((i) => i.path)).toContain("@huggingface/transformers");
  });

  test("answers the protocol: mean pooling, normalized, model loaded once into <installDir>/models", async () => {
    const dir = newInstallDir();
    installFakeTransformers(dir);
    writeFileSync(join(dir, EMBED_HOST_FILE), EMBED_HOST_SOURCE);
    const e = make({ installDir: dir });

    const a = await e.embed(["hello", "world!"], "passage");
    const b = await e.embed(["q"], "query");
    expect(a.map((v) => Array.from(v))).toEqual([
      ["passage: hello".length, 1, 1],
      ["passage: world!".length, 1, 1],
    ]);
    expect(Array.from(b[0])).toEqual(["query: q".length, 1, 1]);

    const c = calls(dir);
    expect(c).toHaveLength(1);
    expect(c[0].task).toBe("feature-extraction");
    expect(c[0].model).toBe("Xenova/multilingual-e5-small");
    expect(c[0].dtype).toBe("q8");
    expect(realpathSync(c[0].cacheDir)).toBe(realpathSync(join(dir, "models")));
  });

  test("--warm loads the model and exits 0", async () => {
    const dir = newInstallDir();
    installFakeTransformers(dir);
    mkdirSync(join(dir, "models"), { recursive: true });
    writeFileSync(join(dir, EMBED_HOST_FILE), EMBED_HOST_SOURCE);
    const proc = Bun.spawn({
      cmd: [resolveBunPath(), join(dir, EMBED_HOST_FILE), "--warm"],
      cwd: dir,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    });
    const timer = setTimeout(() => proc.kill(), 10_000);
    const code = await proc.exited;
    clearTimeout(timer);
    expect(code).toBe(0);
    expect(calls(dir)).toHaveLength(1);
  });

  test("a model that fails to load answers each request with an error line", async () => {
    const dir = newInstallDir();
    const pkg = join(dir, "node_modules", "@huggingface", "transformers");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@huggingface/transformers", type: "module", main: "index.mjs" }));
    writeFileSync(join(pkg, "index.mjs"), `export const env = {};\nexport async function pipeline() { throw new Error("no model files here"); }\n`);
    writeFileSync(join(dir, EMBED_HOST_FILE), EMBED_HOST_SOURCE);
    const e = make({ installDir: dir });
    const err = await fail(e.embed(["a"], "passage"));
    expect(err!.message).toContain("no model files here");
  });
});
