/**
 * `/api/logs`: how a query string becomes a filter, what a draft request must look like, and an
 * AI draft that can only pick labels the repository has.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetPpmDir } from "../../../src/services/ppm-dir.ts";
import { closeTraceDb } from "../../../src/services/session-trace/session-trace-db.ts";
import { _resetLogStoreForTests } from "../../../src/services/logs/log-store.ts";
import { logsRoutes, parseDraftRequest, parseLogQuery } from "../../../src/server/routes/logs.ts";
import { draftReport } from "../../../src/services/logs/log-report-draft.ts";
import { searchTerms } from "../../../src/services/logs/github-issues.ts";

const tempDirs: string[] = [];
const originalHome = process.env.PPM_HOME;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  const home = mkdtempSync(join(tmpdir(), "ppm-logs-routes-"));
  tempDirs.push(home);
  process.env.PPM_HOME = home;
  _resetPpmDir();
  closeTraceDb();
  _resetLogStoreForTests();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

afterAll(() => {
  closeTraceDb();
  _resetLogStoreForTests();
  process.env.PPM_HOME = originalHome;
  _resetPpmDir();
  for (const dir of tempDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* sqlite handles linger on windows */ }
  }
});

describe("parseLogQuery", () => {
  it("reads every filter from the query string", () => {
    expect(parseLogQuery({ src: "ai", lv: "error,warn", off: "ai:sdk,ai:usage", q: "boom", re: "1", cs: "1", chat: "abc", range: "15m", from: "123", before: "p1.2", reach: "p1.0", limit: "50" })).toEqual({
      src: "ai",
      levels: { error: true, warn: true, info: false, debug: false },
      tagsOff: ["ai:sdk", "ai:usage"],
      q: "boom",
      regex: true,
      caseSensitive: true,
      chat: "abc",
      range: "15m",
      from: 123,
      before: "p1.2",
      reach: "p1.0",
      limit: 50,
    });
  });

  it("falls back to the defaults for anything missing or unknown", () => {
    const p = parseLogQuery({ src: "nope", range: "forever" });
    expect(p.src).toBe("all");
    expect(p.range).toBe("1h");
    expect(p.levels).toEqual({ error: true, warn: true, info: true, debug: false });
    expect(p.before).toBeUndefined();
    expect(p.reach).toBeUndefined();
  });
});

describe("parseDraftRequest", () => {
  it("accepts snippets and environment rows", () => {
    expect(parseDraftRequest({ snippets: [{ label: "AI", lines: ["a"] }], environment: [["PPM", "v1"], ["bad"]], note: "n" })).toEqual({
      snippets: [{ label: "AI", lines: ["a"] }],
      environment: [["PPM", "v1"]],
      note: "n",
    });
  });

  it("refuses a malformed or oversized request", () => {
    expect(typeof parseDraftRequest(null)).toBe("string");
    expect(typeof parseDraftRequest({ snippets: [{ label: 1, lines: [] }], environment: [] })).toBe("string");
    expect(typeof parseDraftRequest({ snippets: [{ label: "x", lines: new Array(2001).fill("l") }], environment: [] })).toBe("string");
  });
});

describe("GET /api/logs", () => {
  it("answers a page of records", async () => {
    writeFileSync(join(process.env.PPM_HOME!, "ppm.log"), "[2026-10-06T08:00:00.000Z] [ERROR] [chat] boom\n");
    const res = await logsRoutes.request("/?range=all&lv=error");
    const body = (await res.json()) as { ok: boolean; data: { entries: Array<{ msg: string }> } };
    expect(res.status).toBe(200);
    expect(body.data.entries.map((e) => e.msg)).toEqual(["boom"]);
  });
});

describe("draftReport", () => {
  it("keeps only labels the repository has, whatever the answer says", async () => {
    globalThis.fetch = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    let prompt = "";
    const draft = await draftReport(
      { snippets: [{ label: "AI · 1 line", lines: ["[08:00:00] ERROR chat boom in /home/dev/x"] }], environment: [["PPM", "v0.23.12"]] },
      async (_s, p) => {
        prompt = p;
        return { text: JSON.stringify({ title: "Chat turn fails", labels: ["BUG", "made-up"], what: "w", steps: "1. s", expected: "e" }), tokens: 9 };
      },
    );
    expect(draft).toMatchObject({ title: "Chat turn fails", labels: ["bug"], what: "w", steps: "1. s", expected: "e" });
    expect(prompt).toContain("Labels in the repository: bug, enhancement, question, documentation");
    expect(prompt).not.toContain("/home/dev");
  });
});

describe("draftReport secrets", () => {
  it("takes secrets out of the lines and the note before the AI sees them", async () => {
    globalThis.fetch = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    let prompt = "";
    await draftReport(
      {
        snippets: [{
          label: "Server · 2 lines",
          lines: [
            "TypeError: fetch failed for https://api.telegram.org/bot123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw/getMe",
            '[2026-10-06T08:00:00.000Z] [ERROR] [chat] refresh answered {"access_token":"at-SECRETSECRETSECRET1234"}',
          ],
        }],
        environment: [["PPM", "v0.23.12"]],
        note: "it broke after I set sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
      },
      async (_s, p) => {
        prompt = p;
        return { text: JSON.stringify({ title: "Telegram fails" }), tokens: 1 };
      },
    );
    expect(prompt).toContain("bot123456789:[REDACTED]/getMe");
    for (const secret of ["AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw", "SECRETSECRETSECRET1234", "sk-ant-api03"]) {
      expect(prompt).not.toContain(secret);
    }
  });
});

describe("searchTerms", () => {
  it("drops search qualifiers and keeps the first words", () => {
    expect(searchTerms('Chat "fails" repo:other/x is:closed after a token refresh in Codex')).toBe("Chat fails repo other is closed");
  });
});
