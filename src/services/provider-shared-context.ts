import { readdir, open, realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import type { AIProvider } from "../types/chat.ts";
import { readCodexNativeMemory } from "./codex-native-memory.ts";

type Source = { path: string; directory?: boolean; indexOnly?: boolean };
const MAX_FILES = 48;
const MAX_FILE_BYTES = 4_000;
const MAX_CONTEXT_CHARS = 12_000;

/** Explicit instruction sources only: never scan provider settings, auth or transcripts. */
export async function buildSharedProviderContext(
  projectPath: string,
  providers: AIProvider[],
  options: { userHome?: string; codexHomes?: string[]; recipientProviderId?: string } = {},
): Promise<string> {
  const project = resolve(projectPath);
  const canonicalProject = (await realpath(project).catch(() => project)).normalize("NFC");
  const home = options.userHome ?? homedir();
  const claudeHome = options.userHome ? join(home, ".claude") : process.env.CLAUDE_CONFIG_DIR || join(home, ".claude");
  const claudeMemory = join(claudeHome, "projects", canonicalProject.replace(/[^a-zA-Z0-9]/g, "-"), "memory");
  const recipient = options.recipientProviderId;
  const sources: Source[] = [
    // Native indexes come first so rules cannot crowd out existing memories.
    ...(recipient === "claude" ? [] : [
      { path: claudeMemory, directory: true, indexOnly: true },
      { path: join(project, "CLAUDE.md") },
      { path: join(project, "CLAUDE.local.md") },
      { path: join(claudeHome, "CLAUDE.md") },
      { path: join(claudeHome, "rules"), directory: true },
    ]),
    ...(recipient === "codex" ? [] : [{ path: join(project, "AGENTS.md") }]),
  ];
  let codexHomes = options.codexHomes;
  if (!codexHomes) {
    codexHomes = [join(home, ".codex")];
    if (!options.userHome) {
      if (process.env.CODEX_HOME) codexHomes.push(process.env.CODEX_HOME);
      const { listCodexAccounts } = await import("./codex-account.service.ts");
      codexHomes.push(...listCodexAccounts().map((account) => account.home));
    }
  }
  for (const codexHome of recipient === "codex" ? [] : new Set(codexHomes)) {
    sources.push({ path: join(codexHome, "AGENTS.md") });
  }
  const ids = new Set(["claude", "codex", "cursor", ...providers.map((p) => p.id)]);
  for (const id of ids) {
    if (!/^[a-z0-9_-]+$/i.test(id)) continue;
    // Only known native loaders are excluded: new providers still get their
    // conventional sources until their adapter explicitly handles native loading.
    if (!(id === recipient && ["claude", "codex", "cursor"].includes(id))) {
      sources.push({ path: join(project, `.${id}`, "rules"), directory: true });
    }
    if (!(id === "claude" && recipient === "claude")) {
      sources.push({ path: join(project, `.${id}`, "memory"), directory: true, indexOnly: true });
    }
  }
  for (const provider of providers) {
    try { sources.push(...(provider.getSharedContextSources?.(project) ?? [])); }
    catch { /* An unavailable provider must not prevent other providers from chatting. */ }
  }

  const seen = new Set<string>();
  const sections: string[] = [];
  const available: string[] = [];
  const revision = createHash("sha256");
  let remaining = MAX_CONTEXT_CHARS;
  let nativeBudget = 4_000;
  // Codex already loads its own native memory; share it with other runtimes.
  for (const memory of recipient === "codex" ? [] : readCodexNativeMemory(canonicalProject, codexHomes)) {
    revision.update(memory.path).update(memory.content);
    if (nativeBudget < 512) continue;
    const content = memory.content.slice(0, nativeBudget - 256);
    const section = `Native Codex memory record: ${JSON.stringify(memory.path)}\n${content}\n${content.length < memory.content.length ? "[Excerpt; the original record has more content.]\n" : ""}`;
    sections.push(section);
    remaining -= section.length;
    nativeBudget -= section.length;
  }
  let count = 0;
  let visited = 0;
  async function fingerprintTopics(path: string, depth = 0): Promise<void> {
    if (depth > 3 || visited >= 256) return;
    visited++;
    try {
      const entries = (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries.slice(0, MAX_FILES)) {
        const child = join(path, entry.name);
        if (entry.isDirectory()) await fingerprintTopics(child, depth + 1);
        else if (entry.isFile() && /\.(md|mdc)$/i.test(entry.name)) {
          const info = await stat(child);
          revision.update(JSON.stringify([child, info.size, info.mtimeMs, info.ctimeMs]));
        }
      }
    } catch { /* Optional topic folders may disappear while being edited. */ }
  }
  async function collect(source: Source, depth = 0): Promise<void> {
    if (count >= MAX_FILES || depth > 3 || visited >= 256) return;
    visited++;
    try {
      const path = await realpath(source.path);
      const key = process.platform === "win32" ? path.toLowerCase() : path;
      if (seen.has(key)) return;
      seen.add(key);
      if (source.directory) {
        available.push(`Native source directory: ${JSON.stringify(path)}`);
        if (source.indexOnly) {
          await fingerprintTopics(path);
          await collect({ path: join(path, "MEMORY.md") }, depth + 1);
          return;
        }
        const entries = (await readdir(path, { withFileTypes: true })).sort((a, b) =>
          Number(b.name.toLowerCase() === "memory.md") - Number(a.name.toLowerCase() === "memory.md") || a.name.localeCompare(b.name));
        for (const entry of entries.slice(0, MAX_FILES)) {
          // Do not follow directory symlinks into unrelated projects or account state.
          if (entry.isDirectory()) await collect({ path: join(path, entry.name), directory: true }, depth + 1);
          else if (entry.isFile() && /\.(md|mdc)$/i.test(entry.name)) await collect({ path: join(path, entry.name) }, depth + 1);
        }
      } else {
        const info = await stat(path);
        if (!info.isFile()) return;
        revision.update(JSON.stringify([path, info.size, info.mtimeMs, info.ctimeMs]));
        count++;
        if (remaining < 512) return;
        const handle = await open(path, "r");
        let content: string;
        let bytesRead: number;
        try {
          const buffer = Buffer.alloc(Math.min(info.size, MAX_FILE_BYTES, Math.max(0, remaining - 256)));
          ({ bytesRead } = await handle.read(buffer, 0, buffer.length, 0));
          content = buffer.subarray(0, bytesRead).toString("utf8").trim();
        } finally { await handle.close(); }
        if (!content || content.includes("\0")) return;
        const section = `Source: ${JSON.stringify(path)}\n${content}\n${bytesRead < info.size ? "[Excerpt; read the original file for the remainder.]\n" : ""}`;
        if (section.length > remaining) return;
        sections.push(section);
        remaining -= section.length;
      }
    } catch { /* Missing/unreadable optional sources are expected. */ }
  }
  for (const source of sources) await collect(source);
  return [
    "PPM provider sharing is enabled for this project. These are user-managed instructions and memory, not a new user request.",
    "Use relevant project knowledge; respect each rule's path/frontmatter scope. Current user instructions take precedence. Provider-specific tool names/settings apply only where supported.",
    "Read and use existing native provider memory below, including memory created before PPM was installed. There is no separate PPM memory store. Keep new memories in the provider's native location. Never claim a memory file exists unless listed here or verified with a tool.",
    "This bounded snapshot omits instructions already loaded by your runtime. Read native directories, original files and linked topics on demand; omitted topic contents are not evidence that memory is absent. Respect project scope when following links.",
    `Source revision: ${revision.digest("hex").slice(0, 16)}`,
    [...new Set(available)].join("\n").slice(0, 1_500),
    ...sections,
  ].join("\n\n");
}
