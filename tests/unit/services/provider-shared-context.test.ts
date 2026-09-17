import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildSharedProviderContext } from "../../../src/services/provider-shared-context.ts";
import { stripSharedContext, withSharedContext } from "../../../src/shared/provider-context.ts";
import { parseSessionMessage } from "../../../src/services/jsonl-transcript-parser.ts";
import type { AIProvider } from "../../../src/types/chat.ts";

const dirs: string[] = [];
function fixture() {
  const base = mkdtempSync(join(tmpdir(), "ppm-sharing-"));
  dirs.push(base);
  const project = join(base, "project");
  const userHome = join(base, "home");
  mkdirSync(project);
  mkdirSync(userHome);
  const put = (path: string, content: string) => {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content);
  };
  return { project, userHome, put };
}
afterEach(() => { for (const path of dirs.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe("provider sharing", () => {
  test("shares rules and only the exact project's Claude memory, without auth or transcripts", async () => {
    const { project, userHome, put } = fixture();
    put(join(project, "CLAUDE.md"), "Use Bun.");
    put(join(project, ".claude", "rules", "testing.md"), "Run relevant tests.");
    put(join(project, ".ppm", "shared-memory", "architecture.md"), "OBSOLETE PPM MEMORY");
    put(join(userHome, ".claude", "projects", project.replace(/[^a-zA-Z0-9]/g, "-"), "memory", "MEMORY.md"), "Project fact.");
    put(join(userHome, ".claude", "projects", "another-project", "memory", "MEMORY.md"), "PRIVATE OTHER PROJECT");
    put(join(userHome, ".codex", "auth.json"), "PRIVATE CREDENTIAL");
    put(join(project, ".claude", "settings.json"), "PRIVATE SETTING");
    const context = await buildSharedProviderContext(project, [], { userHome });
    for (const expected of ["Use Bun.", "Run relevant tests.", "Project fact."]) expect(context).toContain(expected);
    expect(context).not.toContain("OBSOLETE PPM MEMORY");
    expect(context).not.toContain(".ppm/shared-memory");
    expect(context).not.toContain("PRIVATE");
  });

  test("future providers share conventional and custom sources without changing the collector", async () => {
    const { project, userHome, put } = fixture();
    put(join(project, ".future", "memory", "MEMORY.md"), "Future fact.");
    put(join(project, "GUIDE.md"), "Custom source.");
    const provider = { id: "future", getSharedContextSources: () => [{ path: join(project, "GUIDE.md") }] } as unknown as AIProvider;
    const context = await buildSharedProviderContext(project, [provider], { userHome });
    expect(context).toContain("Future fact.");
    expect(context).toContain("Custom source.");
  });

  test("refreshes changed memory, bounds content, and tolerates a broken source adapter", async () => {
    const { project, userHome, put } = fixture();
    const path = join(project, "AGENTS.md");
    put(path, "Before.");
    const broken = { id: "broken", getSharedContextSources: () => { throw Error("offline"); } } as unknown as AIProvider;
    expect(await buildSharedProviderContext(project, [broken], { userHome })).toContain("Before.");
    put(path, "After.");
    put(join(project, "CLAUDE.md"), "HUGE".repeat(10_000));
    const context = await buildSharedProviderContext(project, [], { userHome });
    expect(context).toContain("After.");
    expect(context).not.toContain("Before.");
    expect(context.length).toBeLessThan(15_000);
  });

  test("imports pre-existing oversized Claude memory without requiring any PPM files", async () => {
    const { project, userHome, put } = fixture();
    const memory = join(userHome, ".claude", "projects", project.replace(/[^a-zA-Z0-9]/g, "-"), "memory", "MEMORY.md");
    put(memory, "EXISTING_CLAUDE_KNOWLEDGE\n" + "x".repeat(12_170));
    put(join(project, "AGENTS.md"), "RULES".repeat(9_000));
    const context = await buildSharedProviderContext(project, [], { userHome });
    expect(context).toContain("EXISTING_CLAUDE_KNOWLEDGE");
    expect(context).toContain(JSON.stringify(memory));
    expect(context).toContain("read the original file for the remainder");
    expect(context).not.toContain("shared-memory/MEMORY.md");
  });

  test("native user history preserves the actual message and attachments after transport wrapping", () => {
    const text = withSharedContext("Fix the bug", "Shared fact");
    expect(stripSharedContext(text)).toBe("Fix the bug");
    expect(stripSharedContext("ordinary text")).toBe("ordinary text");
    expect(stripSharedContext(text.slice(0, 25))).toBe("");
    const parsed = parseSessionMessage({ uuid: "1", type: "user", message: { content: [{ type: "text", text }] } });
    expect(parsed.content).toBe("Fix the bug");
  });

  test("Codex receives Claude memory without repeating its native rules or expanding memory topics", async () => {
    const { project, userHome, put } = fixture();
    const memory = join(userHome, ".claude", "projects", project.replace(/[^a-zA-Z0-9]/g, "-"), "memory");
    put(join(memory, "MEMORY.md"), "Relevant fact. See topic.md for detail.");
    put(join(memory, "topic.md"), "EXPENSIVE_TOPIC_CONTENT".repeat(1_000));
    put(join(project, "AGENTS.md"), "ALREADY_NATIVE_PROJECT_RULES");
    put(join(userHome, ".codex", "AGENTS.md"), "ALREADY_NATIVE_GLOBAL_RULES");
    put(join(project, ".codex", "rules", "local.md"), "ALREADY_NATIVE_CODEX_RULES");
    put(join(project, "CLAUDE.md"), "CROSS_PROVIDER_RULES");
    const context = await buildSharedProviderContext(project, [], { userHome, recipientProviderId: "codex" });
    expect(context).toContain("Relevant fact.");
    expect(context).toContain("CROSS_PROVIDER_RULES");
    expect(context).toContain(JSON.stringify(memory));
    expect(context).not.toContain("ALREADY_NATIVE");
    expect(context).not.toContain("EXPENSIVE_TOPIC_CONTENT");
  });

  test("Claude skips its own automatically loaded instructions and memory", async () => {
    const { project, userHome, put } = fixture();
    put(join(project, "CLAUDE.md"), "ALREADY_NATIVE_ROOT");
    put(join(project, "CLAUDE.local.md"), "ALREADY_NATIVE_LOCAL");
    put(join(userHome, ".claude", "CLAUDE.md"), "ALREADY_NATIVE_GLOBAL");
    put(join(project, ".claude", "rules", "test.md"), "ALREADY_NATIVE_RULES");
    put(join(userHome, ".claude", "projects", project.replace(/[^a-zA-Z0-9]/g, "-"), "memory", "MEMORY.md"), "ALREADY_NATIVE_MEMORY");
    put(join(project, "AGENTS.md"), "CODEX_RULES");
    const context = await buildSharedProviderContext(project, [], { userHome, recipientProviderId: "claude" });
    expect(context).not.toContain("ALREADY_NATIVE");
    expect(context).toContain("CODEX_RULES");
  });

  test("memory without an index remains discoverable through its native directory", async () => {
    const { project, userHome, put } = fixture();
    const memory = join(project, ".future", "memory");
    put(join(memory, "topic.md"), "LOAD_ON_DEMAND");
    const context = await buildSharedProviderContext(project, [{ id: "future" } as AIProvider], { userHome });
    expect(context).toContain(JSON.stringify(memory));
    expect(context).not.toContain("LOAD_ON_DEMAND");
    put(join(memory, "topic.md"), "CHANGED_TOPIC_CONTENT");
    const updated = await buildSharedProviderContext(project, [{ id: "future" } as AIProvider], { userHome });
    expect(updated).not.toBe(context);
    expect(updated).not.toContain("CHANGED_TOPIC_CONTENT");
  });
});
