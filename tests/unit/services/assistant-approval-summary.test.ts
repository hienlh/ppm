/**
 * What an Assistant approval card says is built by the server from checked input: the thing
 * that will run or be sent is shown whole as the body, everything else comes from PPM's own
 * records, and nothing the agent says about its request reaches the card.
 */
import { describe, expect, it } from "bun:test";
import {
  answerApprovalSummary, closeTabSummary, dbWriteSummary, readOutsideSummary,
} from "../../../src/services/assistant-mcp/assistant-approval-summary.ts";
import { decidingInput } from "../../../src/services/chat-control/approval-deciding-input.ts";
import type { ApprovalSummary } from "../../../src/shared/assistant-approval.ts";
import { SESSION_COLLAB_APPROVAL, type SessionCollabApprovalInput } from "../../../src/shared/session-collab.ts";

/** A session-tool card the Assistant asks, as every surface away from PPM's own card reads it. */
const collabCard = (input: SessionCollabApprovalInput) => decidingInput({ tool: SESSION_COLLAB_APPROVAL, input });

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

  it("names the chat, the mode a message runs in and where that mode came from", () => {
    const message = "Please run the tests.";
    const d = collabCard({
      kind: "message", targetSessionId: "0b6f6a3c-1a7b-4d7e-9b1a-2f0f6d8e9c11", targetTitle: "Fix login", projectName: "api",
      providerId: "claude", permissionMode: "acceptEdits", modeSource: "stored", message,
    });
    expect(d).toMatchObject({ text: message, label: "Message", complete: true });
    expect(d.facts).toContainEqual({ label: "Project", value: "api" });
    // The whole id: two Codex chats of one title started in the same minute share its first 8 characters.
    expect(d.facts).toContainEqual({ label: "Chat", value: "Fix login (0b6f6a3c-1a7b-4d7e-9b1a-2f0f6d8e9c11)" });
    expect(d.facts).toContainEqual({ label: "Runs in", value: "Accept edits — file edits run without asking" });
    expect(d.facts).toContainEqual({ label: "Mode from", value: "the mode saved for this chat" });
    expect(d.facts.find((f) => f.label === "Warning")).toBeUndefined();
  });

  it("highlights a chat that runs every tool without asking", () => {
    const d = collabCard({
      kind: "message", targetSessionId: "s-1", targetTitle: "Deploy", projectName: "api", providerId: "codex",
      permissionMode: "bypassPermissions", modeSource: "running", message: "deploy",
    });
    expect(d.facts).toContainEqual({ label: "Runs in", value: "Bypass permissions — every tool runs without asking" });
    expect(d.facts.find((f) => f.label === "Mode from")?.value).toContain("running session");
    expect(d.facts.find((f) => f.label === "Warning")?.value).toContain("will not ask you first");
    expect(d.title).toContain("Codex chat in \"api\"");
  });

  it("describes a tab close and an outside read from what PPM resolved", () => {
    const close = closeTabSummary({ tabType: "terminal", tabTitle: "zsh", project: "api", reason: "Closing a terminal ends its shell." });
    expect(close.headline).toBe("Close a terminal and end what runs in it");
    expect(close.warning).toBe("Closing a terminal ends its shell.");
    const read = readOutsideSummary({ kind: "unsaved", location: "/etc/hosts" });
    expect(read.headline).toBe("Read the unsaved text of a file outside every registered project");
    expect(read.facts).toEqual([{ label: "File", value: "/etc/hosts" }]);
    const db = readOutsideSummary({ kind: "database", location: "/home/u/.aws/x.db", privateStore: true });
    expect(db.headline).toBe("Read the SQL and rows of a database file where logins or keys are kept");
    expect(db.facts).toEqual([{ label: "Database file", value: "/home/u/.aws/x.db" }]);
    const term = readOutsideSummary({ kind: "terminal", location: "/home/u/.ssh", privateStore: true });
    expect(term.headline).toBe("Read the output of a terminal running where logins or keys are kept");
    const untitled = readOutsideSummary({ kind: "unsaved", location: "" });
    expect(untitled.headline).toBe("Read the text of an untitled editor that belongs to no registered project");
  });

  it("shows a read's path whole, since a cut path could name another file", () => {
    const long = `/home/u/${"deep/".repeat(60)}notes.txt`;
    expect(readOutsideSummary({ kind: "unsaved", location: long }).facts).toEqual([{ label: "File", value: long }]);
  });

  it("names a target chat by its whole id, so two same-titled chats never read alike", () => {
    // UUIDv7: the first 8 characters are the creation time, shared by chats started in one minute.
    const a = "01963f5e-7a10-7b2c-8d3e-111111111111";
    const b = "01963f5e-7a10-7b2c-8d3e-222222222222";
    const chatOf = (sessionId: string) => answerApprovalSummary({
      project: "web", sessionId, sessionTitle: "Fix login", providerId: "codex", decision: "deny",
      deciding: decidingInput({ tool: "Bash", input: { command: "ls" } }),
    }).facts.find((f) => f.label === "Chat")!.value;
    expect(chatOf(a)).not.toBe(chatOf(b));
    expect(chatOf(a)).toBe(`Fix login (${a})`);
  });

  it("cuts an over-long fact rather than letting it take over the card", () => {
    const s = closeTabSummary({ tabType: "editor", tabTitle: "x".repeat(1_000), project: null, reason: "unsaved" });
    expect(s.facts[0]!.value.length).toBeLessThanOrEqual(201);
  });

  it("states a new chat's project, model and mode, and warns about bypass", () => {
    const base = {
      kind: "create" as const, title: "Fix it", providerId: "codex", model: null, task: "fix it", depth: 0,
      askedBy: "assistant" as const, projectName: "web", modeSource: "provider-default" as const,
    };
    const bypass = collabCard({ ...base, permissionMode: "bypassPermissions" });
    expect(bypass.title).toContain("new Codex chat in \"web\"");
    expect(bypass.facts).toContainEqual({ label: "Model", value: "the provider's default" });
    expect(bypass.facts.find((f) => f.label === "Warning")?.value).toContain("without asking");
    expect(collabCard({ ...base, permissionMode: "plan" }).facts.find((f) => f.label === "Warning")).toBeUndefined();
  });

  it("repeats another chat's card verbatim, its long facts uncut", () => {
    const url = `https://example.test/${"p".repeat(400)}`;
    const s = answerApprovalSummary({
      project: "web", sessionId: "abcdef0123456789", sessionTitle: null, providerId: "claude", decision: "allow",
      deciding: decidingInput({ tool: "WebFetch", input: { url, prompt: "read <this> `now`" } }),
    });
    expect(s.facts).toContainEqual({ label: "URL", value: url });
    expect(s.body?.text).toBe("read <this> `now`");
    expect(s.body?.label).toBe("Request");
    expect(s.warning).toContain("as soon as you allow it");
  });

  it("keeps another Assistant card's own body label rather than a generic one", () => {
    const s = answerApprovalSummary({
      project: "web", sessionId: "abcdef0123456789", sessionTitle: null, providerId: "codex", decision: "deny",
      deciding: decidingInput({ tool: "schedule_create", input: {}, summary: { headline: "Create", facts: [], body: { label: "Prompt", text: "say ok", format: "text" } } }),
    });
    expect(s.body).toEqual({ label: "Prompt", text: "say ok", format: "text" });
  });
});
