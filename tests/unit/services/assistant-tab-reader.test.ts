/**
 * Reading a tab's content for the Assistant: a file tab answers with where the file is — resolved
 * against the project the TAB belongs to — and never with the file, which the agent reads with
 * its own read tool; unsaved text, terminal output and a database file's rows from outside every
 * registered project (or a credential store) need the user's approval; PPM's own folder is
 * refused; terminal output loses its escape sequences; long text is read in windows continued
 * with `offset`.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getPpmDir } from "../../../src/services/ppm-dir.ts";
import { _setClaudeProjectsRoot } from "../../../src/services/agent-transcript/claude-projects-root.ts";
import { readDescribedTab, terminalLines, type TabReaderDeps } from "../../../src/services/assistant-mcp/assistant-tab-reader.ts";
import { uiReadTab } from "../../../src/services/assistant-mcp/assistant-ui-read-tool.ts";
import type { AssistantUiOutcome } from "../../../src/services/assistant-mcp/assistant-ui-tools.ts";
import { noApprover, type ApprovalAsk } from "../../../src/services/assistant-mcp/assistant-approval-broker.ts";
import { lineWindow, tailWindow, type TabDescription } from "../../../src/shared/assistant-tab-content.ts";
import { parseTabDescription } from "../../../src/services/assistant-mcp/assistant-tab-description.ts";
import { insertConnection, updateConnection } from "../../../src/services/db.service.ts";

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
  it("answers with the file's absolute path and the tab's own project, never the file", async () => {
    const beta1 = contentOf(await readDescribedTab(editor("src/same.ts", "beta"), 0, deps));
    expect(beta1).toMatchObject({ project: "beta", path: join(beta().path, "src", "same.ts"), unsavedChanges: false });
    expect(beta1.readWith).toContain("your own file-reading tool");
    expect(beta1.text).toBeUndefined();
    expect(JSON.stringify(beta1)).not.toContain("beta copy");
    expect(contentOf(await readDescribedTab(editor("src/same.ts", "alpha"), 0, deps)).path).toBe(join(alpha().path, "src", "same.ts"));
  });

  it("finds the project an absolute path lies in", async () => {
    const c = contentOf(await readDescribedTab(editor(join(beta().path, "src", "same.ts"), null), 0, deps));
    expect(c).toMatchObject({ project: "beta", path: join(beta().path, "src", "same.ts") });
  });

  it("names a file outside every registered project without asking, and without reading it", async () => {
    const c = contentOf(await readDescribedTab(editor(join(root, "outside.txt"), "alpha"), 0, deps));
    expect(c).toMatchObject({ project: null, path: join(root, "outside.txt"), unsavedChanges: false });
    expect(JSON.stringify(c)).not.toContain("not in a project");
  });

  it("refuses PPM's own folder outright", async () => {
    const outcome = await readDescribedTab(editor(join(getPpmDir(), "private.txt"), null), 0, deps);
    expect(outcome).toMatchObject({ kind: "error" });
    if (outcome.kind === "error") expect(outcome.message).toContain("private");
  });

  it("refuses a relative path whose project is not registered any more", async () => {
    expect(await readDescribedTab(editor("src/same.ts", "gone"), 0, deps)).toMatchObject({ kind: "error" });
  });

  it("adds the editor's unsaved text inside a project, unasked", async () => {
    const unsaved = lineWindow("typed but not saved", 0);
    const c = contentOf(await readDescribedTab(editor("src/same.ts", "alpha", { dirty: true, unsaved }), 0, deps));
    expect(c).toMatchObject({ project: "alpha", path: join(alpha().path, "src", "same.ts"), unsavedChanges: true, text: "typed but not saved" });
    expect(c.source).toContain("unsaved");
  });

  it("windows long unsaved text, continued by offset", async () => {
    const text = Array.from({ length: 2500 }, (_, i) => `line ${i + 1}`).join("\n");
    const first = contentOf(await readDescribedTab(editor("long.txt", "beta", { dirty: true, unsaved: lineWindow(text, 0) }), 0, deps));
    expect(first).toMatchObject({ fromLine: 1, toLine: 2000, totalLines: 2500, nextOffset: 2000 });
    expect(first.more).toContain("offset: 2000");
  });

  it("asks before sending the unsaved text of a file outside every project", async () => {
    const desc = editor(join(root, "outside.txt"), null, { dirty: true, unsaved: lineWindow("draft outside", 0) });
    const outcome = await readDescribedTab(desc, 0, deps);
    expect(outcome).toMatchObject({ kind: "needs-approval", why: "outside", subject: "unsaved", details: { path: join(root, "outside.txt") } });
    expect(contentOf(await readDescribedTab(desc, 0, deps, { approved: true })).text).toBe("draft outside");
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
  const refuseAsk = async (): Promise<never> => { throw new Error("nothing should ask"); };

  it("asks the device to describe the tab, then answers with the file's path", async () => {
    const asked: unknown[] = [];
    const result: any = await uiReadTab("s1", { tabId: "editor:src/same.ts", offset: 0 }, refuseAsk, async (sessionId, body, waitMs) => {
      asked.push(body);
      return answer(editor("src/same.ts", "beta"))();
    }, deps);
    expect(asked).toEqual([{ op: "describe_tab", args: { tabId: "editor:src/same.ts", offset: 0 } }]);
    const body = JSON.parse(result.content[0].text);
    expect(body).toMatchObject({ tab: { id: "editor:src/same.ts", type: "editor", project: "beta" }, path: join(beta().path, "src", "same.ts") });
    expect(result.content[0].text).not.toContain("beta copy");
    expect(body.note).toContain("data");
  });

  it("names a saved file outside the projects without a card; its read is the agent's own tool's to ask for", async () => {
    const outsidePath = join(root, "outside.txt");
    const result: any = await uiReadTab("s1", { tabId: "t" }, refuseAsk, answer(editor(outsidePath, null)), deps);
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toMatchObject({ project: null, path: outsidePath });
    expect(result.content[0].text).not.toContain("not in a project");
  });

  it("sends unsaved text from outside the projects only once the user approves, and refuses a garbled description", async () => {
    const outsidePath = join(root, "outside.txt");
    const dirty = editor(outsidePath, null, { dirty: true, unsaved: lineWindow("UNSAVED OUTSIDE", 0) });
    const asks: ApprovalAsk[] = [];
    const declined: any = await uiReadTab("s1", { tabId: "t" }, async (a) => {
      asks.push(a);
      return { verdict: "denied", reason: "The user declined." };
    }, answer(dirty), deps);
    expect(declined.isError).toBe(true);
    expect(JSON.parse(declined.content[0].text)).toMatchObject({ outcome: "declined", action: "read_tab", tabId: "t", path: outsidePath });
    expect(declined.content[0].text).not.toContain("UNSAVED OUTSIDE");
    expect(asks[0]!.summary).toMatchObject({ headline: "Read the unsaved text of a file outside every registered project", facts: [{ label: "File", value: outsidePath }] });

    const approved: any = await uiReadTab("s1", { tabId: "t" }, async () => ({ verdict: "approved" }), answer(dirty), deps);
    expect(JSON.parse(approved.content[0].text)).toMatchObject({ project: null, path: outsidePath, text: "UNSAVED OUTSIDE" });

    const garbled: any = await uiReadTab("s1", { tabId: "t" }, noApprover, answer({ nope: true }), deps);
    expect(garbled.isError).toBe(true);
    const badOffset: any = await uiReadTab("s1", { tabId: "t", offset: -1 }, noApprover, answer({}), deps);
    expect(badOffset.content[0].text).toContain("`offset`");
  });

  it("never reads PPM's own folder, approved or not", async () => {
    const result: any = await uiReadTab("s1", { tabId: "t" }, async () => ({ verdict: "approved" }), answer(editor(join(getPpmDir(), "private.txt"), null)), deps);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).not.toContain("ppm secret");
  });

  it("reads a terminal outside the projects once approved", async () => {
    terminals.set(TERM, { projectPath: root, buffer: "hello from outside\n" });
    try {
      const desc: TabDescription = { id: "terminal:1", type: "terminal", title: "zsh", project: null, area: "grid", terminal: { sessionId: TERM } };
      const asks: ApprovalAsk[] = [];
      const result: any = await uiReadTab("s1", { tabId: "terminal:1" }, async (a) => { asks.push(a); return { verdict: "approved" }; }, answer(desc), deps);
      expect(JSON.parse(result.content[0].text)).toMatchObject({ project: null, folder: root, text: "hello from outside" });
      expect(asks[0]!.summary.headline).toBe("Read the output of a terminal running outside every registered project");
    } finally {
      terminals.clear();
    }
  });
});

describe("a file in a credential store", () => {
  const home = () => join(root, "home");
  const privateDeps = (): TabReaderDeps => ({ ...deps, privateRoots: () => [join(home(), ".aws"), join(alpha().path, ".ssh")] });

  beforeAll(() => {
    mkdirSync(join(alpha().path, ".ssh"), { recursive: true });
    writeFileSync(join(alpha().path, ".ssh", "id_ed25519"), "private key\n");
    mkdirSync(join(home(), ".aws"), { recursive: true });
    writeFileSync(join(home(), ".aws", "credentials"), "aws key\n");
    // A link inside a project into the store is judged by where it points.
    symlinkSync(join(home(), ".aws"), join(beta().path, "aws"), process.platform === "win32" ? "junction" : "dir");
  });

  it("is named without its content; its read is the agent's own tool's to ask for", async () => {
    const c = contentOf(await readDescribedTab(editor(".ssh/id_ed25519", "alpha"), 0, privateDeps()));
    expect(c).toMatchObject({ project: "alpha", path: join(alpha().path, ".ssh", "id_ed25519") });
    expect(JSON.stringify(c)).not.toContain("private key");
  });

  it("asks before sending its unsaved text, even inside a registered project and through a link", async () => {
    const descs = [
      editor(".ssh/id_ed25519", "alpha", { dirty: true, unsaved: lineWindow("typed", 0) }),
      editor("aws/credentials", "beta", { dirty: true, unsaved: lineWindow("typed", 0) }),
    ];
    for (const desc of descs) {
      expect(await readDescribedTab(desc, 0, privateDeps())).toMatchObject({ kind: "needs-approval", why: "private", subject: "unsaved" });
      expect(contentOf(await readDescribedTab(desc, 0, privateDeps(), { approved: true })).text).toBe("typed");
    }
    const ordinary = editor("src/same.ts", "alpha", { dirty: true, unsaved: lineWindow("fine", 0) });
    expect(contentOf(await readDescribedTab(ordinary, 0, privateDeps())).text).toBe("fine");
  });

  it("asks under its own headline, and sends nothing when declined", async () => {
    const asks: ApprovalAsk[] = [];
    const describe = async (): Promise<AssistantUiOutcome> =>
      ({ ok: true, result: { type: "assistant_ui_result", requestId: "r", ok: true, data: editor(".ssh/id_ed25519", "alpha", { dirty: true, unsaved: lineWindow("SECRET DRAFT", 0) }) } });
    const declined: any = await uiReadTab("s1", { tabId: "t" }, async (a) => {
      asks.push(a);
      return { verdict: "denied", reason: "The user declined." };
    }, describe, privateDeps());
    expect(declined.isError).toBe(true);
    expect(declined.content[0].text).not.toContain("SECRET DRAFT");
    expect(asks[0]!.summary.headline).toBe("Read the unsaved text of a file where logins or keys are kept");
  });
});

describe("a database tab", () => {
  let open: number;
  let hidden: number;
  beforeAll(() => {
    open = insertConnection("sqlite", "open-db", { type: "sqlite", path: join(root, "a.db") }).id;
    hidden = insertConnection("sqlite", "private-db", { type: "sqlite", path: join(root, "b.db") }).id;
    updateConnection(hidden, { aiAccess: 0 });
  });
  const dbTab = (database: TabDescription["database"]): TabDescription => ({
    id: "db-query:q", type: "db-query", title: "Query 1", project: null, area: "grid",
    database: { sql: "select secret from users", rows: { columns: ["secret"], rows: [["s3cret"]], more: false }, ...database },
  });

  it("is read for a connection available to the AI", async () => {
    const c = contentOf(await readDescribedTab(dbTab({ connectionId: open }), 0, deps));
    expect(c).toMatchObject({ connection: "open-db", sql: "select secret from users", rows: [["s3cret"]] });
  });

  it("is refused when the connection is not available to the AI, is gone, or neither it nor a file is named", async () => {
    for (const desc of [dbTab({ connectionId: hidden }), dbTab({ connectionId: 987_654 }), dbTab({})]) {
      const outcome = await readDescribedTab(desc, 0, deps);
      expect(outcome.kind).toBe("error");
      expect(JSON.stringify(outcome)).not.toContain("s3cret");
      expect(JSON.stringify(outcome)).not.toContain("select secret");
    }
    const off = await readDescribedTab(dbTab({ connectionId: hidden }), 0, deps);
    if (off.kind === "error") expect(off.message).toContain("not available to the AI");
  });

  const fileTab = (file: NonNullable<TabDescription["database"]>["file"]): TabDescription => ({
    id: "database:file", type: "database", title: "app.db", project: null, area: "grid",
    database: { file, rows: { columns: ["secret"], rows: [["s3cret"]], more: false } },
  });

  it("from a database file inside a registered project is read unasked", async () => {
    const c = contentOf(await readDescribedTab(fileTab({ path: "data/app.db", project: "alpha" }), 0, deps));
    expect(c).toMatchObject({ project: "alpha", file: join(alpha().path, "data", "app.db"), rows: [["s3cret"]] });
    const absolute = contentOf(await readDescribedTab(fileTab({ path: join(beta().path, "app.db") }), 0, deps));
    expect(absolute).toMatchObject({ project: "beta", rows: [["s3cret"]] });
  });

  it("from a database file outside every project, or in a credential store, asks first", async () => {
    const outside = await readDescribedTab(fileTab({ path: join(root, "a.db") }), 0, deps);
    expect(outside).toMatchObject({ kind: "needs-approval", why: "outside", subject: "database", details: { path: join(root, "a.db") } });
    expect(JSON.stringify(outside)).not.toContain("s3cret");
    const store = await readDescribedTab(fileTab({ path: ".ssh/keys.db", project: "alpha" }), 0, { ...deps, privateRoots: () => [join(alpha().path, ".ssh")] });
    expect(store).toMatchObject({ kind: "needs-approval", why: "private", subject: "database" });
    expect(contentOf(await readDescribedTab(fileTab({ path: join(root, "a.db") }), 0, deps, { approved: true })).rows).toEqual([["s3cret"]]);

    const asks: ApprovalAsk[] = [];
    const declined: any = await uiReadTab("s1", { tabId: "database:file" }, async (a) => { asks.push(a); return { verdict: "denied", reason: "no" }; },
      async () => ({ ok: true, result: { type: "assistant_ui_result", requestId: "r", ok: true, data: fileTab({ path: join(root, "a.db") }) } }), deps);
    expect(declined.content[0].text).not.toContain("s3cret");
    expect(asks[0]!.summary).toMatchObject({ headline: "Read the SQL and rows of a database file outside every registered project", facts: [{ label: "Database file", value: join(root, "a.db") }] });
  });

  it("from a database file in PPM's own folder, or of a project no longer registered, is refused", async () => {
    expect(await readDescribedTab(fileTab({ path: join(getPpmDir(), "ppm.db") }), 0, deps)).toMatchObject({ kind: "error" });
    expect(await readDescribedTab(fileTab({ path: "app.db", project: "gone" }), 0, deps)).toMatchObject({ kind: "error" });
  });

  it("keeps the connection id a device sends only when it is a positive whole number", () => {
    const raw = { id: "q", type: "db-query", title: "Q", project: null, area: "grid", database: { connectionId: open, sql: "x" } };
    expect(parseTabDescription(raw)!.database).toEqual({ connectionId: open, sql: "x" });
    for (const bad of ["1", -1, 1.5, null]) {
      expect(parseTabDescription({ ...raw, database: { connectionId: bad, sql: "x" } })!.database).toEqual({ sql: "x" });
    }
    // A file only when no connection is named, its path bounded.
    expect(parseTabDescription({ ...raw, database: { file: { path: "data/a.db", project: "alpha" } } })!.database).toEqual({ file: { path: "data/a.db", project: "alpha" } });
    expect(parseTabDescription({ ...raw, database: { connectionId: open, file: { path: "a.db" } } })!.database).toEqual({ connectionId: open });
    expect(parseTabDescription({ ...raw, database: { file: { path: "x".repeat(5_000) } } })!.database).toEqual({});
  });
});
