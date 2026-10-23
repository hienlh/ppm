import { describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { ExtensionMcpRegistry, type ExtensionToolInvoker, type ExtensionToolsetStore } from "../../../src/services/extension-mcp/extension-mcp-registry.ts";
import { deleteExtension, getExtensionMcpToolsetJson } from "../../../src/services/db.service.ts";
import {
  EXTENSION_TOOLSET_STARTING, MAX_EXPOSED_TOOL_NAME, MAX_EXTENSION_TOOL_RESULT_BYTES, splitExposedToolName, splitToolsetKey,
  validateToolset, type ExtensionMcpToolDefinition,
} from "../../../src/shared/extension-mcp.ts";

const schema = { type: "object", properties: { id: { type: "string" } } };
const tool = (name: string, extra: Partial<ExtensionMcpToolDefinition> = {}) => ({ name, description: `Does ${name}`, inputSchema: schema, ...extra });
const toolset = (id = "fg", tools = [tool("overview"), tool("expand_node")]) => ({ id, title: "Future graph", tools });

function memoryStore() {
  const saved = new Map<string, ExtensionMcpToolDefinition[]>();
  const store: ExtensionToolsetStore = {
    load: (ext, id) => saved.get(`${ext}:${id}`) ?? null,
    save: (ext, ts) => { saved.set(`${ext}:${ts.id}`, ts.tools); },
  };
  return { saved, store };
}

const echo: ExtensionToolInvoker = async (name, args, ctx) => ({ text: `${name} ${JSON.stringify(args)} ${ctx.sessionId} ${ctx.turnOrigin}` });
const ctx = { sessionId: "s1", turnOrigin: "ws" };

describe("toolset validation", () => {
  it("accepts a well-formed toolset and returns a clean copy", () => {
    const checked = validateToolset({ ...toolset(), extra: true });
    expect(checked).toEqual(toolset());
    expect(Object.keys(checked)).toEqual(["id", "title", "tools"]);
  });

  it("refuses every limit the API states", () => {
    const refuse = (value: unknown, message: RegExp) => expect(() => validateToolset(value)).toThrow(message);
    refuse(toolset("F-G"), /toolset.id/);
    refuse({ ...toolset(), title: "" }, /title/);
    refuse(toolset("fg", []), /1-40 tools/);
    refuse(toolset("fg", Array.from({ length: 41 }, (_, i) => tool(`t${i}`))), /1-40 tools/);
    refuse(toolset("fg", [tool("Overview")]), /\.name must be/);
    refuse(toolset("fg", [tool("1abc")]), /\.name must be/);
    refuse(toolset("fg", [tool("ok", { description: "x".repeat(2_001) })]), /description/);
    refuse(toolset("fg", [tool("ok", { inputSchema: { type: "string" } })]), /type "object"/);
    refuse(toolset("fg", [tool("ok", { inputSchema: { type: "object", description: "x".repeat(17_000) } })]), /16384 bytes/);
    refuse(toolset("fg", [tool("same"), tool("same")]), /repeat a name/);
  });

  it("keeps the name Claude sees within 64 characters", () => {
    const longest = "a".repeat(MAX_EXPOSED_TOOL_NAME - "abcdefghijklmnop_".length);
    expect(validateToolset(toolset("abcdefghijklmnop", [tool(longest)])).tools[0]!.name).toBe(longest);
    expect(`mcp__ppm-ext__abcdefghijklmnop_${longest}`.length).toBe(64);
    expect(() => validateToolset(toolset("abcdefghijklmnop", [tool(`${longest}b`)]))).toThrow(/too long/);
  });

  it("splits exposed names and keys at the right boundary", () => {
    expect(splitExposedToolName("fg_expand_node")).toEqual({ toolsetId: "fg", name: "expand_node" });
    expect(splitExposedToolName("overview")).toBeNull();
    expect(splitToolsetKey("@scope/ext:fg")).toEqual({ extensionId: "@scope/ext", toolsetId: "fg" });
    expect(splitToolsetKey("fg")).toBeNull();
  });
});

describe("ExtensionMcpRegistry", () => {
  it("lists a toolset's tools under <toolset>_<tool> and calls the handler with its own name", async () => {
    const registry = new ExtensionMcpRegistry(memoryStore().store);
    registry.register("ext-a", toolset(), echo, 1);
    expect(registry.toolsFor(["ext-a:fg"]).map((t) => t.name)).toEqual(["fg_overview", "fg_expand_node"]);
    expect(registry.list()).toEqual([{ key: "ext-a:fg", extensionId: "ext-a", toolsetId: "fg", title: "Future graph", tools: ["fg_overview", "fg_expand_node"] }]);
    expect(await registry.call("ext-a:fg", "expand_node", { id: "n1" }, ctx)).toEqual({ text: 'expand_node {"id":"n1"} s1 ws' });
  });

  it("never replaces a live toolset, and only the generation that registered it may dispose it", () => {
    const registry = new ExtensionMcpRegistry(memoryStore().store);
    registry.register("ext-a", toolset(), echo, 1);
    expect(() => registry.register("ext-a", toolset(), echo, 2)).toThrow(/already registered/);
    expect(registry.unregister("ext-a", "fg", 2)).toBe(false);
    expect(registry.isLive("ext-a:fg")).toBe(true);
    expect(registry.unregister("ext-a", "fg", 1)).toBe(true);
    registry.register("ext-a", toolset(), echo, 2);
    expect(registry.isLive("ext-a:fg")).toBe(true);
  });

  it("drops only the named extension's toolsets", () => {
    const registry = new ExtensionMcpRegistry(memoryStore().store);
    registry.register("ext-a", toolset("fg"), echo);
    registry.register("ext-a", toolset("ab"), echo);
    registry.register("ext-b", toolset("fg"), echo);
    expect(registry.unregisterExtension("ext-a")).toBe(2);
    expect(registry.list().map((t) => t.key)).toEqual(["ext-b:fg"]);
    registry.clear();
    expect(registry.list()).toEqual([]);
  });

  it("lists the last-known tools while the extension is down and answers 'starting' until it registers again", async () => {
    const { store } = memoryStore();
    const registry = new ExtensionMcpRegistry(store);
    registry.register("ext-a", toolset(), echo);
    registry.unregisterExtension("ext-a");
    expect(registry.toolsFor(["ext-a:fg"]).map((t) => t.name)).toEqual(["fg_overview", "fg_expand_node"]);
    expect(await registry.call("ext-a:fg", "overview", {}, ctx)).toEqual({ text: EXTENSION_TOOLSET_STARTING, isError: true });
    expect((await registry.call("ext-a:fg", "nothing", {}, ctx)).isError).toBe(true);
    expect(registry.toolsFor(["ext-a:zz"])).toEqual([]);
    registry.register("ext-a", toolset(), echo);
    expect((await registry.call("ext-a:fg", "overview", {}, ctx)).isError).toBeUndefined();
  });

  it("turns a failing, malformed or oversized answer into an error result", async () => {
    const registry = new ExtensionMcpRegistry(memoryStore().store);
    registry.register("ext-a", toolset("aa"), async () => { throw new Error("boom"); });
    registry.register("ext-a", toolset("bb"), async () => ({ nope: 1 }));
    // One ASCII byte first, so the cut falls inside a two-byte character.
    registry.register("ext-a", toolset("cc"), async () => ({ text: `x${"é".repeat(MAX_EXTENSION_TOOL_RESULT_BYTES)}`, isError: true }));
    expect(await registry.call("ext-a:aa", "overview", {}, ctx)).toEqual({ text: "The extension's tool failed: boom", isError: true });
    expect((await registry.call("ext-a:bb", "overview", {}, ctx)).isError).toBe(true);
    const cut = await registry.call("ext-a:cc", "overview", {}, ctx);
    expect(cut.isError).toBe(true);
    expect(cut.text).toContain(`only the first ${MAX_EXTENSION_TOOL_RESULT_BYTES} are shown`);
    expect(new TextEncoder().encode(cut.text).length).toBeLessThan(MAX_EXTENSION_TOOL_RESULT_BYTES + 200);
    expect(cut.text.includes("�")).toBe(false);
  });

  it("refuses a call to a tool the toolset does not have", async () => {
    const registry = new ExtensionMcpRegistry(memoryStore().store);
    registry.register("ext-a", toolset(), echo);
    expect(await registry.call("ext-a:fg", "delete_all", {}, ctx)).toEqual({ text: "Unknown tool: delete_all", isError: true });
  });

  it("keeps the definitions in the database until the extension is removed", () => {
    const ext = `mcp-registry-${process.pid}`;
    new ExtensionMcpRegistry().register(ext, toolset(), echo);
    expect(new ExtensionMcpRegistry().toolsFor([`${ext}:fg`]).map((t) => t.name)).toEqual(["fg_overview", "fg_expand_node"]);
    deleteExtension(ext);
    expect(getExtensionMcpToolsetJson(ext, "fg")).toBeNull();
    expect(new ExtensionMcpRegistry().toolsFor([`${ext}:fg`])).toEqual([]);
  });
});
