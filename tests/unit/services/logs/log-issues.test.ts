/**
 * The Issues tab's bookkeeping with the AI replaced by a script: what a run is shown, how its
 * answer becomes issues, that counts come from the logs rather than from the answer, and that a
 * second run only pays for patterns no issue covers yet.
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetPpmDir } from "../../../../src/services/ppm-dir.ts";
import { closeTraceDb } from "../../../../src/services/session-trace/session-trace-db.ts";
import { _resetLogStoreForTests } from "../../../../src/services/logs/log-store.ts";
import {
  _resetIssuesForTests, _setIssuesAskForTests, analyze, getIssues, getIssuesSummary, onIssuesChanged, setAuto, setDismissed,
} from "../../../../src/services/logs/log-issues.ts";
import type { AskFn } from "../../../../src/services/logs/log-ai.ts";
import { redactSecrets } from "../../../../src/services/redact-secrets.ts";

const tempDirs: string[] = [];
const originalHome = process.env.PPM_HOME;
let home = "";
const NOW = Date.now();
const line = (agoSec: number, lv: string, tag: string, msg: string) =>
  `[${new Date(NOW - agoSec * 1000).toISOString()}] [${lv}] [${tag}] ${msg}\n`;

/** The patterns a prompt lists, as label → message. */
function patternsIn(prompt: string): Map<string, string> {
  const out = new Map<string, string>();
  const lines = prompt.split("\n");
  lines.forEach((l, n) => {
    const m = /^(P\d+) · /.exec(l);
    if (m) out.set(m[1]!, lines[n + 1]!.trim());
  });
  return out;
}

const prompts: string[] = [];
function scripted(answer: (patterns: Map<string, string>) => unknown): AskFn {
  return async (_system, prompt) => {
    prompts.push(prompt);
    return { text: `Here you go:\n${JSON.stringify(answer(patternsIn(prompt)))}`, tokens: 1234 };
  };
}
const labelOf = (p: Map<string, string>, text: string) => [...p].find(([, m]) => m.includes(text))?.[0];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ppm-logs-issues-"));
  tempDirs.push(home);
  process.env.PPM_HOME = home;
  _resetPpmDir();
  closeTraceDb();
  _resetLogStoreForTests();
  _resetIssuesForTests();
  prompts.length = 0;
  writeFileSync(join(home, "ppm.log"), [
    line(600, "ERROR", "codex", "account a1 refresh failed: 401 unauthorized"),
    line(500, "ERROR", "codex", "account b2 refresh failed: 401 unauthorized"),
    line(400, "WARN", "codex", "rotating away from account a1 after 3 failures"),
    line(300, "WARN", "file-watcher", "inotify watch limit at 92% for /home/dev/Projects/big"),
    line(200, "INFO", "http", "GET /api/x 200 3ms"),
    line(100, "ERROR", "codex", "account c3 refresh failed: 401 unauthorized"),
  ].join(""));
  setAuto(false);
});

afterAll(() => {
  _setIssuesAskForTests(null);
  closeTraceDb();
  _resetLogStoreForTests();
  _resetIssuesForTests();
  process.env.PPM_HOME = originalHome;
  _resetPpmDir();
  for (const dir of tempDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* sqlite handles linger on windows */ }
  }
});

describe("sorting into issues", () => {
  it("sends each pattern once, redacted, and builds issues with counts from the logs", async () => {
    _setIssuesAskForTests(scripted((p) => ({
      issues: [{
        patterns: [labelOf(p, "refresh failed"), labelOf(p, "rotating away")],
        cls: "setup", title: "A Codex account is signed out", area: "Codex accounts",
        why: "Three refreshes got 401.", fix: "Sign in to the account again.",
      }],
    })));
    await analyze(false);

    expect(prompts).toHaveLength(1);
    const sent = patternsIn(prompts[0]!);
    expect(sent.size).toBe(3); // three copies of the 401 are one pattern; INFO is never sent
    expect(prompts[0]).toContain("3×");
    expect(prompts[0]).toContain("~/Projects/big");
    expect(prompts[0]).not.toContain("/home/dev");

    const r = await getIssues();
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]).toMatchObject({ cls: "setup", title: "A Codex account is signed out", count: 4, errors: 3, warnings: 1, src: "ai", dismissed: false });
    expect(r.issues[0]!.fix).toBe("Sign in to the account again.");
    expect(r.issues[0]!.lines.map((e) => e.lv)).toEqual(["error", "error", "warn", "error"]);
    expect(r.unsorted).toBe(1); // the inotify warning was left out by the answer
    expect(r.lastRun).toEqual({ lines: 5, patterns: 3, tokens: 1234 });
    expect(r.error).toBeNull();
  });

  it("takes secrets out of what it sends, stderr lines and logged objects included", async () => {
    // A process's own stderr reaches ppm.log as printed, and a logged object passes the
    // write-time rules, which key on `token=` and `Bearer`.
    appendFileSync(join(home, "ppm.log"), [
      "TypeError: fetch failed for https://api.telegram.org/bot123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw/sendMessage",
      "    at send (notify.ts:10) with sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
      "",
    ].join("\n") + line(5, "ERROR", "chat", redactSecrets('token refresh answered {"access_token":"at-SECRETSECRETSECRET1234"}')));
    _setIssuesAskForTests(scripted(() => ({ issues: [] })));
    await analyze(true);

    expect(prompts[0]).toContain("bot123456789:[REDACTED]/sendMessage");
    expect(prompts[0]).toContain('{"access_token":"[REDACTED]"}');
    for (const secret of ["AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw", "sk-ant-api03", "SECRETSECRETSECRET1234"]) {
      expect(prompts[0]).not.toContain(secret);
    }
  });

  it("only sends what no issue covers on the next run, and lets it join a known issue", async () => {
    _setIssuesAskForTests(scripted((p) => ({
      issues: [{ patterns: [labelOf(p, "refresh failed")], cls: "bug", title: "Refresh fails", area: "Codex", why: "401s." }],
    })));
    await analyze(false);
    const first = await getIssues();
    const id = first.issues[0]!.id;

    appendFileSync(join(home, "ppm.log"), line(10, "ERROR", "codex", "token endpoint answered 401 for account d4"));
    _setIssuesAskForTests(scripted((p) => ({ attach: [{ pattern: labelOf(p, "token endpoint"), issue: id }] })));
    await analyze(false);

    const sent = patternsIn(prompts[1]!);
    expect([...sent.values()].some((m) => m.includes("refresh failed"))).toBe(false); // covered
    expect([...sent.values()].some((m) => m.includes("rotating away"))).toBe(false); // skipped by run one
    expect(prompts[1]).toContain(`${id} [bug] Refresh fails`);
    const r = await getIssues();
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]!.count).toBe(4);
  });

  it("keeps fixes only where the person can act on them", async () => {
    _setIssuesAskForTests(scripted((p) => ({
      issues: [{ patterns: [labelOf(p, "refresh failed")], cls: "bug", title: "x", area: "y", why: "z", fix: "do something" }],
    })));
    await analyze(false);
    expect((await getIssues()).issues[0]!.fix).toBeUndefined();
  });

  it("ignores patterns and classes the answer made up", async () => {
    _setIssuesAskForTests(scripted(() => ({
      issues: [
        { patterns: ["P99"], cls: "bug", title: "ghost", area: "x", why: "y" },
        { patterns: ["P1"], cls: "catastrophe", title: "bad class", area: "x", why: "y" },
      ],
    })));
    await analyze(false);
    expect((await getIssues()).issues).toEqual([]);
  });

  it("re-sorts everything in the window on a full run", async () => {
    _setIssuesAskForTests(scripted((p) => ({ issues: [{ patterns: [labelOf(p, "refresh failed")], cls: "bug", title: "old", area: "a", why: "w" }] })));
    await analyze(false);
    _setIssuesAskForTests(scripted((p) => ({ issues: [{ patterns: [...p.keys()], cls: "expected", title: "all fine", area: "a", why: "w" }] })));
    await analyze(true);
    expect(patternsIn(prompts[1]!).size).toBe(3);
    const r = await getIssues();
    expect(r.issues.map((i) => i.title)).toEqual(["all fine"]);
    expect(r.unsorted).toBe(0);
  });

  it("records a failed run instead of throwing it at a reader", async () => {
    _setIssuesAskForTests(async () => { throw new Error("Claude took too long to answer"); });
    await expect(analyze(false)).rejects.toThrow("too long");
    const r = await getIssues();
    expect(r.error).toBe("Claude took too long to answer");
    expect(r.running).toBe(false);
  });
});

describe("dismissing, the badge and Auto", () => {
  async function oneBug(): Promise<string> {
    _setIssuesAskForTests(scripted((p) => ({ issues: [{ patterns: [labelOf(p, "refresh failed")], cls: "bug", title: "Refresh fails", area: "Codex", why: "401s." }] })));
    await analyze(false);
    return (await getIssues()).issues[0]!.id;
  }

  it("counts open likely bugs for the rail badge, and hides a dismissed one", async () => {
    const id = await oneBug();
    expect((await getIssuesSummary()).likelyBugs).toBe(1);
    let events = 0;
    const off = onIssuesChanged(() => events++);
    expect(await setDismissed(id, true)).toBe(true);
    off();
    expect(events).toBe(1);
    expect((await getIssues()).issues[0]!.dismissed).toBe(true);
    expect((await getIssuesSummary()).likelyBugs).toBe(0);
    await setDismissed(id, false);
    expect((await getIssuesSummary()).likelyBugs).toBe(1);
    expect(await setDismissed("nope", true)).toBe(false);
  });

  it("keeps what it learned across a restart", async () => {
    const id = await oneBug();
    await setDismissed(id, true);
    expect(existsSync(join(home, "logs-issues.json"))).toBe(true);
    expect(readFileSync(join(home, "logs-issues.json"), "utf8")).not.toContain("refresh failed: 401"); // fingerprints, not raw lines
    _resetIssuesForTests();
    const r = await getIssues();
    expect(r.issues.map((i) => [i.id, i.dismissed])).toEqual([[id, true]]);
  });

  it("starts a run by itself when Auto is on and something is new, at most every ten minutes", async () => {
    _setIssuesAskForTests(scripted(() => ({ issues: [] })));
    setAuto(true);
    await getIssues();
    // The run was started in the background; let it finish.
    await analyze(false);
    expect(prompts.length).toBeGreaterThanOrEqual(1);
    const runs = prompts.length;
    appendFileSync(join(home, "ppm.log"), line(1, "ERROR", "chat", "something new"));
    _resetLogStoreForTests();
    await getIssues();
    await new Promise((r) => setTimeout(r, 20));
    expect(prompts.length).toBe(runs);
  });
});
