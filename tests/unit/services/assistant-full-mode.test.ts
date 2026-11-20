import { beforeEach, describe, expect, it } from "bun:test";
import {
  createFullMode, FULL_MODE_PER_HOUR, FULL_MODE_PER_TURN, hardLimitReason, type FullModeAction,
} from "../../../src/services/assistant/assistant-full-mode.ts";
import { commandSendsOut, mcpToolNameReads, mcpToolSendsOut } from "../../../src/services/assistant/assistant-outbound-action.ts";

const NONE: ReadonlySet<number> = new Set();

describe("hardLimitReason: what asks even in Full mode", () => {
  const asks: Array<[string, FullModeAction]> = [
    ["a push", { tool: "git_sync", input: { action: "push" } }],
    ["the public link on", { tool: "public_link_set", input: { enabled: true } }],
    ["a public port forward", { tool: "port_forward_start", input: { port: 3000, via: "cloudflare" } }],
    ["a port forward with no transport named (Cloudflare is the default)", { tool: "port_forward_start", input: { port: 3000 } }],
    ["another chat's card", { tool: "chat_answer_approval", input: { allow: true } }],
    ["a database write on an unlisted connection", { tool: "db_query", input: { sql: "delete from t" }, connectionId: 7 }],
    ["a database write with no connection id", { tool: "db_query", input: { sql: "delete from t" } }],
    ["a tab in a private folder", { tool: "ui_read_tab", input: { tabId: "t" }, touchesPrivate: true }],
    ["an extension's command", { tool: "ui_run_command", input: { id: "ext:git-graph.push" } }],
  ];
  for (const [what, action] of asks) {
    it(`asks for ${what}`, () => expect(hardLimitReason(action, NONE)).toBeString());
  }

  const runs: Array<[string, FullModeAction]> = [
    ["a fetch", { tool: "git_sync", input: { action: "fetch" } }],
    ["a pull", { tool: "git_sync", input: { action: "pull" } }],
    ["a commit", { tool: "git_commit", input: { message: "x" } }],
    ["the public link off", { tool: "public_link_set", input: { enabled: false } }],
    ["a Tailscale forward", { tool: "port_forward_start", input: { port: 3000, via: "tailscale" } }],
    ["a message to a chat", { tool: "send_to_session", input: { message: "go on" } }],
    ["a new chat", { tool: "create_session", input: { title: "x" } }],
    ["a schedule", { tool: "schedule_save", input: { cron: "0 9 * * *" } }],
    ["a chat delete", { tool: "chat_delete", input: { chat: "x" } }],
    ["a tab outside the projects", { tool: "ui_read_tab", input: { tabId: "t" } }],
  ];
  for (const [what, action] of runs) {
    it(`lets ${what} run`, () => expect(hardLimitReason(action, NONE)).toBeNull());
  }

  it("lets a database write run on a listed connection", () => {
    expect(hardLimitReason({ tool: "db_query", input: {}, connectionId: 7 }, new Set([7]))).toBeNull();
  });

  it("asks before changing a listed connection, which could move its unasked writes elsewhere", () => {
    expect(hardLimitReason({ tool: "db_connection_save", input: { id: 7, path: "/data/prod.db" } }, new Set([7]))).toBeString();
    expect(hardLimitReason({ tool: "db_connection_save", input: { id: 8, name: "x" } }, new Set([7]))).toBeNull();
  });

  it("lets PPM's own commands run", () => {
    expect(hardLimitReason({ tool: "ui_run_command", input: { id: "settings.open" } }, NONE)).toBeNull();
  });
});

describe("createFullMode", () => {
  let full = true;
  let userStarted = true;
  let now = 0;
  let recorded: Array<{ sessionId: string; entry: Record<string, unknown> }> = [];
  const fm = createFullMode({
    fullMode: () => full,
    userStartedTurn: async () => userStarted,
    dbWriteConnections: () => new Set([3]),
    record: (sessionId, entry) => { recorded.push({ sessionId, entry }); },
    now: () => now,
  });
  const send: FullModeAction = { tool: "send_to_session", input: { message: "x" } };

  beforeEach(() => {
    full = true; userStarted = true; now = 1_000_000; recorded = [];
    fm.reset();
  });

  it("runs an ordinary action in a turn the user started, and records it", async () => {
    expect(await fm.verdict("s1", send)).toEqual({ run: true });
    expect(recorded).toEqual([{ sessionId: "s1", entry: { tool: "send_to_session", input: { message: "x" }, mode: "full" } }]);
  });

  it("asks in Ask mode", async () => {
    full = false;
    expect(await fm.verdict("s1", send)).toMatchObject({ run: false });
    expect(recorded).toEqual([]);
  });

  it("asks in a turn PPM started, or one whose start PPM did not see", async () => {
    userStarted = false;
    expect(await fm.verdict("s1", send)).toMatchObject({ run: false, reason: expect.stringContaining("turns the user started") });
  });

  it("asks when telling who started the turn fails", async () => {
    const broken = createFullMode({
      fullMode: () => true, userStartedTurn: async () => { throw new Error("tracker gone"); },
      dbWriteConnections: () => NONE, record: () => {}, now: () => 0,
    });
    expect((await broken.verdict("s1", send)).run).toBe(false);
  });

  it("asks for a hard limit even in a user turn", async () => {
    expect((await fm.verdict("s1", { tool: "git_sync", input: { action: "push" } })).run).toBe(false);
    expect((await fm.verdict("s1", { tool: "db_query", input: {}, connectionId: 3 })).run).toBe(true);
  });

  it(`asks after ${FULL_MODE_PER_TURN} actions in one turn, and counts again after the turn ends`, async () => {
    for (let i = 0; i < FULL_MODE_PER_TURN; i++) expect((await fm.verdict("s1", send)).run).toBe(true);
    expect(await fm.verdict("s1", send)).toMatchObject({ run: false, reason: expect.stringContaining("this turn") });
    expect((await fm.verdict("s2", send)).run).toBe(true);
    fm.turnEnded("s1");
    expect((await fm.verdict("s1", send)).run).toBe(true);
  });

  it(`asks after ${FULL_MODE_PER_HOUR} actions in an hour, across sessions, and runs again once they age out`, async () => {
    for (let i = 0; i < FULL_MODE_PER_HOUR; i++) {
      const sessionId = `s${Math.floor(i / FULL_MODE_PER_TURN)}`;
      expect((await fm.verdict(sessionId, send)).run).toBe(true);
    }
    expect(await fm.verdict("other", send)).toMatchObject({ run: false, reason: expect.stringContaining("last hour") });
    now += 60 * 60_000;
    expect((await fm.verdict("other", send)).run).toBe(true);
  });

  it("keeps a turn's count when a provider renames the session mid-turn", async () => {
    for (let i = 0; i < FULL_MODE_PER_TURN; i++) expect((await fm.verdict("old", send)).run).toBe(true);
    fm.migrated("old", "new");
    expect((await fm.verdict("new", send)).run).toBe(false);
  });

  it("a refused action does not use up the count", async () => {
    for (let i = 0; i < 20; i++) await fm.verdict("s1", { tool: "chat_answer_approval", input: {} });
    expect((await fm.verdict("s1", send)).run).toBe(true);
  });
});

describe("commandSendsOut", () => {
  const out = [
    "git push", "git -C /work/app push origin main", "git -c http.extraHeader=x push --force",
    "npm publish --access public", "bun publish", "cargo publish", "docker push img:1",
    "gh pr create --fill", "gh issue comment 3 --body x", "gh release upload v1 a.zip", "gh api repos/o/r/issues -X POST",
    "gh api repos/o/r/issues -f title=x", "curl -X POST https://x.test", "curl -sSd @a.json https://x.test",
    "curl --data-binary @a https://x.test", "curl -F file=@a https://x.test", "curl --json '{}' https://x.test",
    "Invoke-RestMethod https://x -Method Post -Body $b", "iwr https://x -InFile a.txt", "wget --post-data=a https://x",
    "ssh host uptime", "scp a host:b", "rsync -a dir host:dir", "echo hi | mail -s x a@b.c", "Send-MailMessage -To a@b.c",
    "curl -d@file https://x.test", "curl -dfoo https://x.test", "curl --request=POST https://x.test", "curl -X Post https://x.test",
    "gh api repos/o/r/issues --method=POST", "gh api repos/o/r/issues --field=title=x", "git send-email a.patch",
    "cd /work && git push", "echo ok\ngit push",
  ];
  for (const c of out) it(`finds: ${c}`, () => expect(commandSendsOut(c)).toBeString());

  const stays = [
    "git status", "git -C /work/app log --oneline", "git pull", "git fetch --all", "gh pr view 3", "gh pr list",
    "gh issue list", "gh api repos/o/r/issues", "curl https://x.test", "curl -sf https://x.test", "curl -fsSL https://x.test -o a",
    "Invoke-WebRequest https://x", "npm test", "bun run build", "echo ssh-agent", "rg push src",
  ];
  for (const c of stays) it(`lets through: ${c}`, () => expect(commandSendsOut(c)).toBeNull());
});

describe("commandSendsOut on a huge command", () => {
  it("does not scan past the limit, and stays fast below it", () => {
    expect(commandSendsOut("git ".repeat(9000))).toBe("a command too long for PPM to check");
    const t = performance.now();
    commandSendsOut("git ".repeat(7900));
    commandSendsOut("curl ".repeat(6000));
    expect(performance.now() - t).toBeLessThan(200);
  });
});

describe("user MCP tools", () => {
  it("reads by the verb a tool name starts with, in any naming style", () => {
    for (const n of ["list_channels", "get-issue", "searchMessages", "read_thread", "fetch", "describeTable"]) expect(mcpToolNameReads(n)).toBe(true);
    for (const n of ["post_message", "create_issue", "sendEmail", "update-page", "delete_file", "chat_postMessage", "query", "run_sql"]) expect(mcpToolNameReads(n)).toBe(false);
  });

  it("asks only for a user server's tool that may post", () => {
    expect(mcpToolSendsOut("mcp__slack__post_message")).toBeString();
    expect(mcpToolSendsOut("mcp__slack__list_channels")).toBeNull();
    expect(mcpToolSendsOut("Bash")).toBeNull();
  });
});
