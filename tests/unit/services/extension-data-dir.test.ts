import { describe, it, expect, afterAll } from "bun:test";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";
import { extensionDataDir, extensionDataDirName } from "../../../src/services/extension-data-dir.ts";
import { getPpmDir } from "../../../src/services/ppm-dir.ts";
import { extensionService } from "../../../src/services/extension.service.ts";
import { insertExtension, deleteExtension } from "../../../src/services/db.service.ts";
import type { RpcChannel } from "../../../src/services/extension-rpc.ts";

describe("extensionDataDirName", () => {
  it("turns a scoped npm id into one folder name", () => {
    expect(extensionDataDirName("@scope/name")).toBe("__scope__name");
  });

  it("keeps a plain id as it is", () => {
    expect(extensionDataDirName("future-graph")).toBe("future-graph");
  });

  it("refuses an id that climbs out with ..", () => {
    expect(() => extensionDataDirName("../escape")).toThrow();
    expect(() => extensionDataDirName("@scope/../../etc")).toThrow();
    expect(() => extensionDataDirName("a..b")).toThrow();
  });

  it("refuses path characters that are not part of an npm name", () => {
    for (const id of ["a\\b", "C:evil", "a b", "", "."]) {
      expect(() => extensionDataDirName(id)).toThrow();
    }
  });
});

describe("extensionDataDir", () => {
  it("is a direct child of <ppm dir>/extension-data", () => {
    const root = resolve(getPpmDir(), "extension-data");
    const dir = extensionDataDir("@scope/name");
    expect(dir).toBe(resolve(root, "__scope__name"));
    const rel = relative(root, dir);
    expect(rel.startsWith("..") || isAbsolute(rel)).toBe(false);
  });

  it("lives under the isolated PPM_HOME the tests run with", () => {
    expect(process.env.PPM_HOME).toBeTruthy();
    expect(extensionDataDir("x").startsWith(resolve(process.env.PPM_HOME!))).toBe(true);
  });
});

/** The private surface needed to ask the activated extension something. */
interface WorkerAccess {
  ensureWorker(): { rpc: RpcChannel };
  terminateWorker(): Promise<void>;
}

describe("activation hands the data dir to the extension", () => {
  const id = "@probe/storage-ext";
  const extDir = resolve(getPpmDir(), "extensions", "node_modules", "@probe", "storage-ext");

  afterAll(async () => {
    await extensionService.deactivate(id);
    await (extensionService as unknown as WorkerAccess).terminateWorker();
    deleteExtension(id);
    rmSync(resolve(getPpmDir(), "extensions", "node_modules", "@probe"), { recursive: true, force: true });
    rmSync(extensionDataDir(id), { recursive: true, force: true });
  });

  it("creates the folder before activate() and exposes it as context.globalStoragePath", async () => {
    mkdirSync(extDir, { recursive: true });
    // What activate() saw is recorded at that moment: the folder must exist by then, not later.
    writeFileSync(resolve(extDir, "index.js"), [
      `import { existsSync } from "node:fs";`,
      `export function activate(context, api) {`,
      `  const seen = { path: context.globalStoragePath, existed: existsSync(context.globalStoragePath), ppm: typeof api.ppm };`,
      `  api.commands.registerCommand("probe.storage", () => seen);`,
      `}`,
    ].join("\n"));
    const manifest = { id, name: id, version: "1.0.0", main: "index.js" };
    insertExtension({ id, version: "1.0.0", display_name: null, description: null, icon: null, enabled: 1, manifest: JSON.stringify(manifest) });

    await extensionService.activate(id);
    const { rpc } = (extensionService as unknown as WorkerAccess).ensureWorker();
    const reply = await rpc.sendRequest<{ ok: boolean; result: { path: string; existed: boolean; ppm: string } }>(
      "ext:command:execute", "probe.storage",
    );

    expect(reply.ok).toBe(true);
    expect(reply.result.path).toBe(resolve(process.env.PPM_HOME!, "extension-data", "__probe__storage-ext"));
    expect(reply.result.existed).toBe(true);
    expect(reply.result.ppm).toBe("object");
    expect(existsSync(reply.result.path)).toBe(true);
  });
});
