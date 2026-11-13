/**
 * Task 16: PPM memory in the chat's shared context (requirements 6.5, 6.6, 11.3).
 *
 * - `buildSharedProviderContext(..., { ppmMemory: true })` leaves out every `indexOnly` memory
 *   source (Claude's project memory folder, `.<id>/memory`, Antigravity's knowledge) and Codex's
 *   native memory, and keeps the rule and instruction files; without the option nothing changes.
 * - `prepareSendOptions` with memory on (and not a `/` command) asks the memory host (run here
 *   in-process) to run `memorySync.ensureSynced`,
 *   never failing the message on a sync error, and appends the `<ppm_memory>` list; memory off or
 *   `share_provider_context: false` → no sync and no list; the snapshot hash keeps an unchanged
 *   list from being sent twice.
 *
 * PPM_HOME is a temp dir (the preloaded test-setup sets it before any import); every other path is
 * a temp dir too. The real sync is replaced on the shared `memorySync` object, so no test reads a
 * real provider store.
 */
import "../../test-setup.ts";
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSharedProviderContext } from "../../../src/services/provider-shared-context.ts";
import { AntigravityProvider } from "../../../src/providers/antigravity/antigravity-provider.ts";
import { MockProvider } from "../../../src/providers/mock-provider.ts";
import { providerRegistry } from "../../../src/providers/registry.ts";
import { chatService } from "../../../src/services/chat.service.ts";
import { configService } from "../../../src/services/config.service.ts";
import { memorySync } from "../../../src/services/memory/memory-sync.ts";
import { memoryDir, memoryStore } from "../../../src/services/memory/memory-store.ts";
import { getMemoryIndex } from "../../../src/services/memory/memory-index.ts";
import { projectMemoryKey } from "../../../src/services/memory/memory-paths.ts";
import { createMemoryHostClient, setMemoryHost } from "../../../src/services/memory/memory-host-client.ts";
import { inProcessMemoryChannel } from "../../../src/services/memory/memory-host.ts";
import type { AIProvider, ChatEvent, SendMessageOpts } from "../../../src/types/chat.ts";

const dirs: string[] = [];
const tempDir = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};
afterAll(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const put = (path: string, content: string) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
};

/** A Codex home holding one native memory for `project`, as Codex's own databases store it. */
function codexHomeWithMemory(base: string, project: string, content: string): string {
  const home = join(base, "codex-home");
  mkdirSync(home, { recursive: true });
  const state = new Database(join(home, "state_5.sqlite"));
  state.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, cwd TEXT, memory_mode TEXT)");
  state.query("INSERT INTO threads VALUES (?,?,?)").run("t1", project, "enabled");
  const memories = new Database(join(home, "memories_1.sqlite"));
  memories.exec("CREATE TABLE stage1_outputs (thread_id TEXT, raw_memory TEXT, rollout_summary TEXT, generated_at INTEGER)");
  memories.query("INSERT INTO stage1_outputs VALUES (?,?,?,?)").run("t1", content, "rollout", Date.now());
  memories.close();
  state.close();
  return home;
}

function sharingFixture() {
  const base = tempDir("ppm-memory-chat-ctx-");
  const project = join(base, "project");
  const userHome = join(base, "home");
  mkdirSync(project, { recursive: true });
  mkdirSync(userHome, { recursive: true });
  const claudeMemory = join(userHome, ".claude", "projects", project.replace(/[^a-zA-Z0-9]/g, "-"), "memory");
  // Rule and instruction files: kept either way.
  put(join(project, "CLAUDE.md"), "PROJECT_CLAUDE_RULE");
  put(join(project, "AGENTS.md"), "PROJECT_AGENTS_RULE");
  put(join(project, "GEMINI.md"), "PROJECT_GEMINI_RULE");
  put(join(project, ".claude", "rules", "testing.md"), "CLAUDE_RULES_DIR_RULE");
  put(join(project, ".agents", "rules", "style.md"), "AGENTS_RULES_DIR_RULE");
  put(join(userHome, ".claude", "CLAUDE.md"), "USER_CLAUDE_RULE");
  // Memory indexes: left out once PPM memory is on.
  put(join(claudeMemory, "MEMORY.md"), "CLAUDE_MEMORY_INDEX_FACT");
  put(join(project, ".codex", "memory", "MEMORY.md"), "DOT_CODEX_MEMORY_FACT");
  put(join(project, ".cursor", "memory", "MEMORY.md"), "DOT_CURSOR_MEMORY_FACT");
  const knowledge = join(userHome, ".gemini", "antigravity", "knowledge");
  put(join(knowledge, "MEMORY.md"), "ANTIGRAVITY_KNOWLEDGE_FACT");
  const codexHome = codexHomeWithMemory(base, project, "CODEX_NATIVE_MEMORY_FACT");
  const antigravity = new AntigravityProvider({ customHome: userHome }) as unknown as AIProvider;
  return { project, userHome, codexHomes: [codexHome], providers: [antigravity], claudeMemory, knowledge };
}

const RULES = ["PROJECT_CLAUDE_RULE", "PROJECT_AGENTS_RULE", "PROJECT_GEMINI_RULE", "CLAUDE_RULES_DIR_RULE", "AGENTS_RULES_DIR_RULE", "USER_CLAUDE_RULE"];
const MEMORY_EXCERPTS = ["CLAUDE_MEMORY_INDEX_FACT", "DOT_CODEX_MEMORY_FACT", "DOT_CURSOR_MEMORY_FACT", "ANTIGRAVITY_KNOWLEDGE_FACT", "CODEX_NATIVE_MEMORY_FACT"];

describe("buildSharedProviderContext with PPM memory", () => {
  test("without the option every memory index and Codex's native memory are shared as today", async () => {
    const f = sharingFixture();
    const context = await buildSharedProviderContext(f.project, f.providers, { userHome: f.userHome, codexHomes: f.codexHomes, recipientProviderId: "mock" });
    for (const text of [...RULES, ...MEMORY_EXCERPTS]) expect(context).toContain(text);
    const off = await buildSharedProviderContext(f.project, f.providers, { userHome: f.userHome, codexHomes: f.codexHomes, recipientProviderId: "mock", ppmMemory: false } as any);
    expect(off).toBe(context);
  });

  test("ppmMemory drops the indexOnly memory sources and Codex's native memory, keeping rules", async () => {
    const f = sharingFixture();
    const context = await buildSharedProviderContext(f.project, f.providers, { userHome: f.userHome, codexHomes: f.codexHomes, recipientProviderId: "mock", ppmMemory: true } as any);
    for (const text of RULES) expect(context).toContain(text);
    for (const text of MEMORY_EXCERPTS) expect(context).not.toContain(text);
    // The sources are gone, not only their excerpts: no directory listed, no native record named.
    expect(context).not.toContain(JSON.stringify(f.claudeMemory));
    expect(context).not.toContain(JSON.stringify(f.knowledge));
    expect(context).not.toContain(JSON.stringify(join(f.project, ".codex", "memory")));
    expect(context).not.toContain("stage1_outputs");
    // It no longer claims there is no PPM memory store.
    expect(context).not.toContain("There is no separate PPM memory store");
  });

  test("a memory index changing does not move the context's revision while PPM memory is on", async () => {
    const f = sharingFixture();
    const opts = { userHome: f.userHome, codexHomes: f.codexHomes, recipientProviderId: "mock", ppmMemory: true } as any;
    const before = await buildSharedProviderContext(f.project, f.providers, opts);
    put(join(f.claudeMemory, "MEMORY.md"), "CLAUDE_MEMORY_INDEX_FACT changed");
    put(join(f.claudeMemory, "topic.md"), "a new topic");
    expect(await buildSharedProviderContext(f.project, f.providers, opts)).toBe(before);
  });
});

describe("prepareSendOptions with PPM memory", () => {
  class CaptureProvider extends MockProvider {
    id = "memory-ctx-test";
    supportsSharedContext = true;
    calls: Array<{ message: string; opts?: SendMessageOpts }> = [];
    async *sendMessage(_id: string, message: string, opts?: SendMessageOpts): AsyncIterable<ChatEvent> {
      this.calls.push({ message, opts });
      yield { type: "text", content: "ok" };
    }
  }

  const provider = new CaptureProvider();
  const originalEnsure = memorySync.ensureSynced;
  // The memory host's own code, run in this process: the patched `memorySync` is the one it calls.
  const host = createMemoryHostClient({
    channel: inProcessMemoryChannel(),
    config: () => ({ ai: {}, codexHomes: [], projects: [] }),
  });
  let originalAi: any;
  let syncCalls: string[] = [];
  let syncError: Error | null = null;
  let project = "";
  let sessionId = "";

  const setAi = (patch: Record<string, unknown>) => configService.set("ai", { ...originalAi, ...patch });

  async function addMemory(name: string, description: string): Promise<string> {
    const { record } = await memoryStore.write(
      { scope: "project", projectPath: project, name, description, type: "project", body: `${name} body` },
      { caller: "tool" },
    );
    await getMemoryIndex().reconcile(memoryDir("project", project), "project", projectMemoryKey(project));
    return record.id;
  }

  const send = async (message: string) => {
    for await (const _ of chatService.sendMessage(provider.id, sessionId, message)) { /* drain */ }
    return provider.calls.at(-1)!;
  };

  beforeEach(async () => {
    originalAi = structuredClone(configService.get("ai"));
    project = tempDir("ppm-memory-chat-project-");
    writeFileSync(join(project, "CLAUDE.md"), "PREPARE_PROJECT_RULE");
    providerRegistry.register(provider);
    const session = await provider.createSession({});
    session.projectPath = project;
    sessionId = session.id;
    syncCalls = [];
    syncError = null;
    setMemoryHost(host);
    (memorySync as any).ensureSynced = async (projectPath: string) => {
      syncCalls.push(projectPath);
      if (syncError) throw syncError;
      return { projectPath, providers: {} };
    };
  });

  afterEach(async () => {
    (memorySync as any).ensureSynced = originalEnsure;
    setMemoryHost(null);
    configService.set("ai", originalAi);
    await provider.deleteSession(sessionId);
  });

  test("memory on: syncs the project first and appends the <ppm_memory> list to the shared context", async () => {
    setAi({ share_provider_context: true, memory: { enabled: true } });
    const id = await addMemory("Deploy steps", "how the app is deployed");
    const opts = await chatService.prepareSendOptions(provider.id, sessionId, "hello");
    expect(syncCalls).toEqual([project]);
    expect(opts.sharedContext).toContain("PREPARE_PROJECT_RULE");
    expect(opts.sharedContext).toContain("<ppm_memory>");
    expect(opts.sharedContext).toContain(`${id}  Deploy steps — how the app is deployed`);
    // The list is appended after the shared context.
    expect(opts.sharedContext!.indexOf("PREPARE_PROJECT_RULE")).toBeLessThan(opts.sharedContext!.indexOf("<ppm_memory>"));
  });

  test("the sync runs before the list is built, so what it imported is listed", async () => {
    setAi({ share_provider_context: true, memory: { enabled: true } });
    let imported = "";
    (memorySync as any).ensureSynced = async (projectPath: string) => {
      syncCalls.push(projectPath);
      imported = await addMemory("Imported during sync", "came from a provider");
      return { projectPath, providers: {} };
    };
    const opts = await chatService.prepareSendOptions(provider.id, sessionId, "hello");
    expect(syncCalls).toEqual([project]);
    expect(imported).not.toBe("");
    expect(opts.sharedContext).toContain(`${imported}  Imported during sync`);
  });

  test("a sync that fails is logged and the message still gets its options and list", async () => {
    setAi({ share_provider_context: true, memory: { enabled: true } });
    const id = await addMemory("Survives a failed sync", "still listed");
    syncError = new Error("claude store unreadable");
    const opts = await chatService.prepareSendOptions(provider.id, sessionId, "hello");
    expect(syncCalls).toEqual([project]);
    expect(opts.sharedContext).toContain("PREPARE_PROJECT_RULE");
    expect(opts.sharedContext).toContain(id);
  });

  test("memory off: no sync and no list, today's shared context", async () => {
    await addMemory("Hidden while off", "never listed");
    setAi({ share_provider_context: true, memory: { enabled: false } });
    const opts = await chatService.prepareSendOptions(provider.id, sessionId, "hello");
    expect(syncCalls).toEqual([]);
    expect(opts.sharedContext).toContain("PREPARE_PROJECT_RULE");
    expect(opts.sharedContext).not.toContain("<ppm_memory>");
    expect(opts.sharedContext).toContain("There is no separate PPM memory store");
  });

  test("shared provider context off: memory does not run either", async () => {
    await addMemory("Hidden while sharing off", "never listed");
    setAi({ share_provider_context: false, memory: { enabled: true } });
    const opts = await chatService.prepareSendOptions(provider.id, sessionId, "hello");
    expect(syncCalls).toEqual([]);
    expect(opts.sharedContext ?? "").not.toContain("<ppm_memory>");
  });

  test("a / command neither syncs nor gets the list", async () => {
    setAi({ share_provider_context: true, memory: { enabled: true } });
    await addMemory("Not for commands", "never listed");
    const opts = await chatService.prepareSendOptions(provider.id, sessionId, "/compact");
    expect(syncCalls).toEqual([]);
    expect(opts.sharedContext ?? "").not.toContain("<ppm_memory>");
    await chatService.prepareSendOptions(provider.id, sessionId, "  /review now");
    expect(syncCalls).toEqual([]);
  });

  test("an unchanged list is not sent again; a changed one is", async () => {
    setAi({ share_provider_context: true, memory: { enabled: true } });
    const first = await addMemory("First memory", "sent once");
    expect((await send("hello")).opts?.sharedContext).toContain(first);
    expect((await send("again")).opts?.sharedContext).toBeUndefined();
    expect(syncCalls).toEqual([project, project]);
    const second = await addMemory("Second memory", "arrives later");
    const third = (await send("after a new memory")).opts?.sharedContext;
    expect(third).toContain("<ppm_memory>");
    expect(third).toContain(second);
    expect((await send("and again")).opts?.sharedContext).toBeUndefined();
  });
});
