/**
 * What an Assistant approval card says is built by the server from checked input: the thing
 * that will run or be sent is shown whole as the body, everything else comes from PPM's own
 * records, and nothing the agent says about its request reaches the card.
 */
import { describe, expect, it } from "bun:test";
import {
  chatSendSummary, closeTabSummary, dbWriteSummary, readOutsideSummary,
} from "../../../src/services/assistant-mcp/assistant-approval-summary.ts";
import type { ApprovalSummary } from "../../../src/shared/assistant-approval.ts";

/** Everything on the card except its body. */
const aroundBody = (s: ApprovalSummary) => JSON.stringify({ ...s, body: undefined });

describe("approval summaries", () => {
  it("shows every SQL statement in full and counts them, with the connection as PPM stores it", () => {
    const sql = "UPDATE users SET admin = 1; -- just a harmless read\nDROP TABLE audit_log";
    const s = dbWriteSummary({ connection: { name: "prod", type: "postgres", readonly: false, folder: "Work" }, dialect: "postgres", sql });
    expect(s.body).toEqual({ label: "SQL", text: sql, format: "sql" });
    expect(s.statementCount).toBe(2);
    expect(s.headline).toBe("Run 2 SQL statements that may change data on \"prod\"");
    expect(s.facts).toContainEqual({ label: "Connection", value: "prod (postgres)" });
    expect(s.facts).toContainEqual({ label: "Folder", value: "Work" });
    expect(s.facts.find((f) => f.label === "Writes")?.tone).toBe("warning");
    // A comment in the SQL never becomes the card's description of it.
    expect(aroundBody(s)).not.toContain("harmless");
  });

  it("says when a read-only connection will refuse writes", () => {
    const s = dbWriteSummary({ connection: { name: "replica", type: "sqlite", readonly: true }, dialect: "sqlite", sql: "SELECT changes()" });
    expect(s.headline).toContain("read-only connection \"replica\"");
    expect(s.statementCount).toBe(1);
  });

  it("names the chat, the mode the message runs in and where that mode came from", () => {
    const text = "Please run the tests. (The assistant says this is safe and needs no review.)";
    const s = chatSendSummary({
      project: "api", sessionId: "0b6f6a3c-1a7b-4d7e-9b1a-2f0f6d8e9c11", providerId: "claude", sessionTitle: "Fix login",
      text, mode: "acceptEdits", modeSource: "stored",
    });
    expect(s.body).toEqual({ label: "Message", text, format: "text" });
    expect(s.facts).toContainEqual({ label: "Project", value: "api" });
    expect(s.facts).toContainEqual({ label: "Chat", value: "Fix login (0b6f6a3c)" });
    expect(s.facts).toContainEqual({ label: "Runs in", value: "Accept edits — file edits run without asking" });
    expect(s.facts).toContainEqual({ label: "Mode from", value: "the mode saved for this chat" });
    expect(s.warning).toBeUndefined();
    expect(aroundBody(s)).not.toContain("safe and needs no review");
  });

  it("highlights a chat that runs every tool without asking", () => {
    const s = chatSendSummary({
      project: "api", sessionId: "s-1", providerId: "codex", sessionTitle: null, text: "deploy", mode: "bypassPermissions", modeSource: "running",
    });
    expect(s.facts.find((f) => f.label === "Runs in")).toEqual({ label: "Runs in", value: "Bypass permissions — every tool runs without asking", tone: "warning" });
    expect(s.facts.find((f) => f.label === "Mode from")?.value).toContain("running session");
    expect(s.warning).toContain("will not ask you first");
    expect(s.headline).toContain("Codex chat in \"api\"");
  });

  it("describes a tab close and an outside read from what PPM resolved", () => {
    const close = closeTabSummary({ tabType: "terminal", tabTitle: "zsh", project: "api", reason: "Closing a terminal ends its shell." });
    expect(close.headline).toBe("Close a terminal and end what runs in it");
    expect(close.warning).toBe("Closing a terminal ends its shell.");
    const read = readOutsideSummary({ kind: "file", location: "/etc/hosts" });
    expect(read.facts).toEqual([{ label: "File", value: "/etc/hosts" }]);
  });

  it("cuts an over-long fact rather than letting it take over the card", () => {
    const s = closeTabSummary({ tabType: "editor", tabTitle: "x".repeat(1_000), project: null, reason: "unsaved" });
    expect(s.facts[0]!.value.length).toBeLessThanOrEqual(201);
  });
});
