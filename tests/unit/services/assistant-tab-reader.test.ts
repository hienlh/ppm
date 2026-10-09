/**
 * Reading a tab's content for the Assistant: a file is resolved against the project the TAB
 * belongs to, a file outside every registered project needs the user's approval, PPM's own
 * folder is refused, terminal output loses its escape sequences, and long text is read in
 * windows continued with `offset`.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getPpmDir } from "../../../src/services/ppm-dir.ts";
import { _setClaudeProjectsRoot } from "../../../src/services/agent-transcript/claude-projects-root.ts";
import { readDescribedTab, terminalLines, type TabReaderDeps } from "../../../src/services/assistant-mcp/assistant-tab-reader.ts";
import { uiReadTab } from "../../../src/services/assistant-mcp/assistant-ui-read-tool.ts";
import type { AssistantUiOutcome } from "../../../src/services/assistant-mcp/assistant-ui-tools.ts";
import { lineWindow, tailWindow, type TabDescription } from "../../../src/shared/assistant-tab-content.ts";

let root: string;
let claudeRoot: string;
const alpha = () => ({ name: "alpha", path: join(root, "alpha") });
const beta = () => ({ name: "beta", path: join(root, "beta") });
const TERM = "0b6f6a3c-1a7b-4d7e-9b1a-2f0f6d8e9c11";
const terminals = new Map<string, { projectPath: string; buffer: string }>();
const chatReads: unknown[] = [];

const deps: TabReaderDeps = {
  listProjects: () => [alpha(), beta()],
  terminal: { get: (id) => terminals.get(id), getBuffer: (id) => terminals.get(id)?.buffer ?? "" },
  readChat: async (target, opts) => {
    chatReads.push({ target, opts });
    return { start: 5, total: 35, messages: [{ role: "user", at: null, text: "hello" }] };
  },
};

const editor = (filePath: string, project: string | null, extra: Partial<NonNullable<TabDescription["editor"]>> = {}): TabDescription => ({
  id: `editor:${filePath}`, type: "editor", title: filePath, project, area: "grid",
  editor: { untitled: false, special: false, dirty: false, filePath, ...extra },
});

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "ppm-asst-read-"));
  claudeRoot = join(root, "claude-projects");
  for (const p of [alpha(), beta()]) mkdirSync(join(p.path, "src"), { recursive: true });
  writeFileSync(join(alpha().path, "src", "same.ts"), "alpha copy\n");
  writeFileSync(join(beta().path, "src", "same.ts"), "beta copy\n");
  writeFileSync(join(beta().path, "long.txt"), Array.from({ length: 2500 }, (_, i) => `line ${i + 1}`).join("\n"));
  writeFileSync(join(root, "outside.txt"), "not in a project\n");
  writeFileSync(join(getPpmDir(), "private.txt"), "ppm secret\n");
  _setClaudeProjectsRoot(claudeRoot);
});
afterAll(() => {
  _setClaudeProjectsRoot(null);
  rmSync(root, { recursive: true, force: true });
});

const contentOf = (outcome: Awaited<ReturnType<typeof readDescribedTab>>) => {
  if (outcome.kind !== "content") throw new Error(`expected content, got ${JSON.stringify(outcome)}`);
  return outcome.content as Record<string, any>;
};

describe("reading a file tab", () => {
  it("resolves a relative path against the tab's own project", async () => {
    expect(contentOf(await readDescribedTab(editor("src/same.ts", "beta"), 0, deps))).toMatchObject({ project: "beta", path: "src/same.ts", text: "beta copy" });
    expect(contentOf(await readDescribedTab(editor("src/same.ts", "alpha"), 0, deps)).text).toBe("alpha copy");
  });

  it("reads an absolute path inside another registered project", async () => {
    const c = contentOf(await readDescribedTab(editor(join(beta().path, "src", "same.ts"), null), 0, deps));
    expect(c).toMatchObject({ project: "beta", text: "beta copy" });
  });

  it("needs the user's approval for a file outside every registered project", async () => {
    const outcome = await readDescribedTab(editor(join(root, "outside.txt"), "alpha"), 0, deps);
    expect(outcome.kind).toBe("needs-approval");
    if (outcome.kind === "needs-approval") expect(outcome.details.path).toBe(join(root, "outside.txt"));
  });

  it("refuses PPM's own folder outright", async () => {
    const outcome = await readDescribedTab(editor(join(getPpmDir(), "private.txt"), null), 0, deps);
    expect(outcome).toMatchObject({ kind: "error" });
    if (outcome.kind === "error") expect(outcome.message).toContain("private");
  });

  it("returns the editor's unsaved text instead of the disk when the tab is dirty", async () => {
    const unsaved = lineWindow("typed but not saved", 0);
    const c = contentOf(await readDescribedTab(editor("src/same.ts", "alpha", { dirty: true, unsaved }), 0, deps));
    expect(c).toMatchObject({ project: "alpha", text: "typed but not saved" });
    expect(c.source).toContain("unsaved");
  });

  it("reads long files in windows continued by offset", async () => {
    const first = contentOf(await readDescribedTab(editor("long.txt", "beta"), 0, deps));
    expect(first).toMatchObject({ fromLine: 1, toLine: 2000, totalLines: 2500, nextOffset: 2000 });
    expect(first.more).toContain("offset: 2000");
    const rest = contentOf(await readDescribedTab(editor("long.txt", "beta"), 2000, deps));
    expect(rest).toMatchObject({ fromLine: 2001, toLine: 2500, totalLines: 2500 });
    expect(rest.nextOffset).toBeUndefined();
    expect(rest.text.split("\n")[0]).toBe("line 2001");
  });
});

describe("text windows", () => {
  it("stops at the byte budget and cuts a single line longer than it", () => {
    const w = lineWindow(["a".repeat(30), "b".repeat(30), "c"].join("\n"), 0, 2000, 63);
    expect(w).toMatchObject({ fromLine: 1, toLine: 2, nextOffset: 2 });
    const huge = lineWindow("z".repeat(1_000), 0, 2000, 200);
    expect(huge.toLine).toBe(1);
    expect(huge.text).toContain("line cut");
  });

  it("reads a tail and steps further back with offset", () => {
    const lines = Array.from({ length: 1000 }, (_, i) => `l${i + 1}`);
    expect(tailWindow(lines, 0)).toMatchObject({ fromLine: 601, toLine: 1000, nextOffset: 400 });
    expect(tailWindow(lines, 400)).toMatchObject({ fromLine: 201, toLine: 600, nextOffset: 800 });
  });
});

describe("reading a terminal tab", () => {
  const term = (sessionId?: string): TabDescription => ({
    id: "terminal:1", type: "terminal", title: "Terminal", project: "alpha", area: "dock", terminal: sessionId ? { sessionId } : {},
  });

  it("strips colours and cursor sequences and returns the newest lines", async () => {
    const output = ["\x1b[32mok\x1b[0m", "\x1b]0;title\x07progress 10%\rprogress 100%", ...Array.from({ length: 500 }, (_, i) => `out ${i}`), "\x1b[31merror: boom\x1b[0m", ""].join("\r\n");
    terminals.set(TERM, { projectPath: alpha().path, buffer: output });
    const c = contentOf(await readDescribedTab(term(TERM), 0, deps));
    expect(c.project).toBe("alpha");
    expect(c.text).not.toContain("\x1b");
    expect(c.text.split("\n").at(-1)).toBe("error: boom");
    expect(c.toLine - c.fromLine + 1).toBe(400);
    expect(terminalLines(output).slice(0, 2)).toEqual(["ok", "progress 100%"]);
  });

  it("needs approval for a shell started outside every project, and says when it is gone", async () => {
    terminals.set(TERM, { projectPath: root, buffer: "x" });
    expect((await readDescribedTab(term(TERM), 0, deps)).kind).toBe("needs-approval");
    terminals.clear();
    expect(await readDescribedTab(term(TERM), 0, deps)).toMatchObject({ kind: "error" });
    expect(contentOf(await readDescribedTab(term(), 0, deps)).readable).toBe(false);
  });
});

describe("reading a chat tab", () => {
  it("reads the last messages of a chat proven to be the tab project's", async () => {
    const id = crypto.randomUUID();
    const dir = join(claudeRoot, alpha().path.replace(/[/\\:.]/g, "-"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${id}.jsonl`), '{"type":"user"}\n');
    const desc: TabDescription = { id: "chat:x", type: "chat", title: "c", project: "alpha", area: "grid", details: { sessionId: id, providerId: "claude" } };
    const c = contentOf(await readDescribedTab(desc, 0, deps));
    expect(c).toMatchObject({ project: "alpha", sessionId: id, start: 5, total: 35 });
    expect(c.more).toContain("offset: 5");
    expect(chatReads.at(-1)).toMatchObject({ opts: { limit: 30 } });
    const elsewhere = await readDescribedTab({ ...desc, project: "beta" }, 0, deps);
    expect(elsewhere).toMatchObject({ kind: "error" });
  });

  it("describes other tab types without content", async () => {
    const c = contentOf(await readDescribedTab({ id: "logs", type: "logs", title: "Logs", project: null, area: "grid" }, 0, deps));
    expect(c.readable).toBe(false);
  });
});

describe("ui_read_tab", () => {
  const answer = (data: unknown) => async (): Promise<AssistantUiOutcome> =>
    ({ ok: true, result: { type: "assistant_ui_result", requestId: "r", ok: true, data } });

  it("asks the device to describe the tab, then reads it", async () => {
    const asked: unknown[] = [];
    const result: any = await uiReadTab("s1", { tabId: "editor:src/same.ts", offset: 0 }, async (sessionId, body, waitMs) => {
      asked.push(body);
      return answer(editor("src/same.ts", "beta"))();
    }, deps);
    expect(asked).toEqual([{ op: "describe_tab", args: { tabId: "editor:src/same.ts", offset: 0 } }]);
    const body = JSON.parse(result.content[0].text);
    expect(body).toMatchObject({ tab: { id: "editor:src/same.ts", type: "editor", project: "beta" }, text: "beta copy" });
    expect(body.note).toContain("data");
  });

  it("answers needs-approval for a file outside the projects, and refuses a garbled description", async () => {
    const outside: any = await uiReadTab("s1", { tabId: "t" }, answer(editor(join(root, "outside.txt"), null)), deps);
    expect(outside.isError).toBe(true);
    expect(JSON.parse(outside.content[0].text)).toMatchObject({ outcome: "needs-approval", action: "read_tab", tabId: "t" });
    const garbled: any = await uiReadTab("s1", { tabId: "t" }, answer({ nope: true }), deps);
    expect(garbled.isError).toBe(true);
    const badOffset: any = await uiReadTab("s1", { tabId: "t", offset: -1 }, answer({}), deps);
    expect(badOffset.content[0].text).toContain("`offset`");
  });
});
