/**
 * The issue a report becomes: context lines around the picked ones, the redaction the switches
 * ask for, the footer naming what was removed, and a link that carries title, labels and body.
 */
import { describe, expect, it } from "bun:test";
import { issueUrl, reportBody, snippetLines, type ReportSnippet } from "../../../src/web/lib/logs/logs-report.ts";
import { foldRepeats } from "../../../src/web/lib/logs/logs-view-model.ts";
import type { LogEntry } from "../../../src/shared/logs-model.ts";

const T = Date.UTC(2026, 9, 6, 1, 35, 55);
const e = (id: string, s: number, msg: string, lv: LogEntry["lv"] = "error"): LogEntry =>
  ({ id, ts: T + s * 1000, lv, src: "ai", tag: "sdk", msg });

function snippet(ctx: ReportSnippet["ctx"]): ReportSnippet {
  return {
    id: "s1",
    src: "ai",
    rows: foldRepeats([e("p1", 0, "turn failed for /home/dev/x"), e("p2", 1, "rotation skipped", "info")]),
    ctx,
    around: {
      before: [e("b1", -3, "one", "info"), e("b2", -2, "two", "info"), e("b3", -1, "two", "info")],
      after: [e("a1", 2, "after", "info")],
    },
  };
}

const fields = { title: "Turn fails", labels: ["bug"], what: "It stopped for dev@example.com.", steps: "", expected: "" };

describe("snippetLines", () => {
  it("adds as many lines around as asked, folding repeats among them", () => {
    expect(snippetLines(snippet(0)).map((l) => [l.row.entry.id, l.ctx])).toEqual([["p1", false], ["p2", false]]);
    expect(snippetLines(snippet(5)).map((l) => [l.row.entry.id, l.row.count, l.ctx])).toEqual([
      ["b1", 1, true], ["b2", 2, true], ["p1", 1, false], ["p2", 1, false], ["a1", 1, true],
    ]);
  });
});

describe("reportBody", () => {
  it("writes the sections, the lines in a fence and what was removed", () => {
    const body = reportBody({
      fields,
      snippets: [snippet(0)],
      environment: [["PPM", "v0.23.12"], ["Host", "Linux at /home/dev"]],
      redact: { home: true, email: true, chats: true, projects: [] },
    });
    expect(body).toContain("### What happened\nIt stopped for <email>.");
    expect(body).toContain("### Steps to reproduce\n_Not filled in_");
    expect(body).not.toContain("### Expected");
    expect(body).toContain("<summary>AI & chat · 01:35:55–01:35:56 UTC · 2 lines</summary>");
    expect(body).toContain("[2026-10-06T01:35:55.000Z] [ERROR] [sdk] turn failed for ~/x");
    expect(body).toContain("- Host: Linux at ~");
    expect(body).toContain("Removed before sending: secrets, home paths, emails, chat ids.");
    expect(body).not.toContain("/home/dev");
  });

  it("takes secrets out whatever the switches say", () => {
    const leaky: ReportSnippet = {
      id: "s2",
      src: "server",
      rows: foldRepeats([{
        id: "p9", ts: T, lv: "error", src: "server", tag: "stderr",
        msg: "TypeError: fetch failed for https://api.telegram.org/bot123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw/getMe",
        more: ["    at send (notify.ts:10) with sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"],
      }]),
      ctx: 0,
      around: null,
    };
    const body = reportBody({
      fields: { ...fields, what: "It began when I set GITHUB_TOKEN=ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789." },
      snippets: [leaky],
      environment: [],
      redact: { home: false, email: false, chats: false },
    });
    expect(body).toContain("bot123456789:[REDACTED]/getMe");
    for (const secret of ["AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw", "sk-ant-api03", "ghp_"]) expect(body).not.toContain(secret);
    expect(body).toContain("Removed before sending: secrets.");
  });

  it("marks replacements for the preview only", () => {
    const opts = { fields, snippets: [], environment: [], redact: { home: false, email: true, chats: false } };
    expect(reportBody({ ...opts, mark: true })).toContain("\u0001<email>\u0002");
    expect(reportBody(opts)).not.toContain("\u0001");
  });
});

describe("issueUrl", () => {
  it("opens a new issue with the title, labels and body, or without the body", () => {
    expect(issueUrl("A & B", ["bug", "area: chat"], "x y")).toBe(
      "https://github.com/hienlh/ppm/issues/new?title=A%20%26%20B&labels=bug%2Carea%3A%20chat&body=x%20y",
    );
    expect(issueUrl("t", [], null)).toBe("https://github.com/hienlh/ppm/issues/new?title=t");
  });
});
