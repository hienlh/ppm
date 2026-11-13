/**
 * An extension activated again after a failed activation must get its toolsets back. Runs the
 * real extension host worker and the real registry: what an activation leaves behind is decided
 * across both threads.
 */
import { afterAll, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { getPpmDir } from "../../../src/services/ppm-dir.ts";
import { extensionService } from "../../../src/services/extension.service.ts";
import { extensionMcpRegistry } from "../../../src/services/extension-mcp/extension-mcp-registry.ts";
import { deleteExtension, insertExtension } from "../../../src/services/db.service.ts";
import { extensionDataDir } from "../../../src/services/extension-data-dir.ts";

const scope = "@probe-mcp-reactivate";
const ctx = { sessionId: "s1", turnOrigin: "ws" };
const toolsetSource = `{ id: "re", title: "Re", tools: [{ name: "ping", description: "Ping", inputSchema: { type: "object" } }] }`;

/** Writes an extension whose activate() is `body`, and records it as installed and enabled. */
function installProbe(name: string, body: string): string {
  const id = `${scope}/${name}`;
  const dir = resolve(getPpmDir(), "extensions", "node_modules", scope, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, "index.js"), `let attempts = 0;\nconst toolset = ${toolsetSource};\n${body}\n`);
  const manifest = { id, name: id, version: "1.0.0", main: "index.js" };
  insertExtension({ id, version: "1.0.0", display_name: null, description: null, icon: null, enabled: 1, manifest: JSON.stringify(manifest) });
  return id;
}

/** The private surface the worker is torn down through. */
interface WorkerAccess {
  terminateWorker(): Promise<void>;
}

const installed: string[] = [];

afterAll(async () => {
  for (const id of installed) await extensionService.deactivate(id);
  await (extensionService as unknown as WorkerAccess).terminateWorker();
  for (const id of installed) {
    deleteExtension(id);
    rmSync(extensionDataDir(id), { recursive: true, force: true });
  }
  rmSync(resolve(getPpmDir(), "extensions", "node_modules", scope), { recursive: true, force: true });
});

describe("extension toolsets across a failed activation", () => {
  it("ignores a registration made after the activation failed, so the next activation serves the toolset", async () => {
    const id = installProbe("late", [
      "export async function activate(context, api) {",
      "  attempts++;",
      "  if (attempts === 1) {",
      "    // Still running after its activation was reported as failed, as a timed-out one does.",
      "    setTimeout(() => { api.ppm.mcp.registerToolset(toolset, async () => ({ text: 'zombie' })); }, 30);",
      "    throw new Error('first activation fails');",
      "  }",
      "  await api.ppm.mcp.registerToolset(toolset, async () => ({ text: `pong ${attempts}` })).registered;",
      "}",
    ].join("\n"));
    installed.push(id);

    await expect(extensionService.activate(id)).rejects.toThrow(/first activation fails/);
    await new Promise((r) => setTimeout(r, 200));
    expect(extensionMcpRegistry.isLive(`${id}:re`)).toBe(false);

    await extensionService.activate(id);
    expect(await extensionMcpRegistry.call(`${id}:re`, "ping", {}, ctx)).toEqual({ text: "pong 2" });
  }, 20_000);

  it("clears whatever an earlier activation left registered before activating again", async () => {
    const id = installProbe("stale", [
      "export async function activate(context, api) {",
      "  attempts++;",
      "  await api.ppm.mcp.registerToolset(toolset, async () => ({ text: `fresh ${attempts}` })).registered;",
      "}",
    ].join("\n"));
    installed.push(id);
    // An entry no activation of this worker owns, as a lost race or an older worker would leave.
    extensionMcpRegistry.register(id, { id: "re", title: "Re", tools: [{ name: "ping", description: "Ping", inputSchema: { type: "object" } }] },
      async () => ({ text: "stale" }));

    await extensionService.activate(id);
    expect(await extensionMcpRegistry.call(`${id}:re`, "ping", {}, ctx)).toEqual({ text: "fresh 1" });
  }, 20_000);
});
