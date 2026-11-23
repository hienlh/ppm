/**
 * Recognising Claude Code's "No conversation found", the switch for carrying history over, the
 * signed-out message, and the SDK's echo of a result error that was already shown.
 */
import { describe, it, expect } from "bun:test";
import {
  cliSignedOutMessage, isCliSignInRequest, isEchoOfResultError, isSessionMissingResult, resultErrorText, resumeRecoveryOn, sessionMissingMessage,
} from "../../../src/providers/claude-session-missing.ts";

/** The result CLI 2.1.322 printed for `--resume <unknown id>` in an empty config dir (trimmed). */
const NO_CONVERSATION = {
  type: "result", subtype: "error_during_execution", duration_ms: 0, is_error: true, num_turns: 0,
  session_id: "9c3f9ae3-0000-4000-8000-000000000000",
  errors: ["No conversation found with session ID: 9c3f9ae3-0000-4000-8000-000000000000"],
};

describe("isSessionMissingResult", () => {
  it("recognises the CLI's own result", () => {
    expect(isSessionMissingResult(NO_CONVERSATION)).toBe(true);
  });

  it("ignores other first-event failures and later results", () => {
    expect(isSessionMissingResult({ ...NO_CONVERSATION, errors: ["spawn ENOENT"] })).toBe(false);
    expect(isSessionMissingResult({ ...NO_CONVERSATION, num_turns: 3 })).toBe(false);
    expect(isSessionMissingResult({ ...NO_CONVERSATION, subtype: "success" })).toBe(false);
    expect(isSessionMissingResult({ type: "assistant" })).toBe(false);
    expect(isSessionMissingResult(null)).toBe(false);
  });
});

describe("resumeRecoveryOn", () => {
  it("is off until chosen", () => {
    expect(resumeRecoveryOn(undefined)).toBe(false);
    expect(resumeRecoveryOn({})).toBe(false);
    expect(resumeRecoveryOn({ resume_recovery: false })).toBe(false);
    expect(resumeRecoveryOn({ resume_recovery: true })).toBe(true);
  });
});

describe("sessionMissingMessage", () => {
  it("says what the next message does, and where to turn recovery on when it is off", () => {
    const off = sessionMissingMessage("off");
    expect(off.split("\n")[0]).toBe("Claude Code on this computer no longer has this conversation.");
    expect(off).toContain("next message starts a new session");
    expect(off).toContain("Settings → AI Provider");
    expect(sessionMissingMessage("no-history")).toContain("PPM has no copy of it either");
  });
});

describe("cliSignedOutMessage", () => {
  it("keeps the CLI's words and names both ways to sign in", () => {
    const message = cliSignedOutMessage("Not logged in · Please run /login");
    expect(message.split("\n")[0]).toBe("Claude Code on this computer is signed out.");
    expect(message).toContain("Claude said: “Not logged in · Please run /login”");
    expect(message).toContain("Settings → Accounts");
    expect(message).toContain("`claude auth login`");
  });

  it("still guides without the CLI's text", () => {
    expect(cliSignedOutMessage("")).not.toContain("Claude said");
  });

  it("is used only when the CLI asks for its own sign-in, not for a rejected key", () => {
    expect(isCliSignInRequest("Not logged in · Please run /login")).toBe(true);
    expect(isCliSignInRequest("Failed to authenticate. API Error: 401 invalid x-api-key")).toBe(false);
  });
});

describe("the SDK's echo of an error result", () => {
  it("builds the text the way the SDK remembers it", () => {
    expect(resultErrorText(NO_CONVERSATION)).toBe(NO_CONVERSATION.errors[0]);
    expect(resultErrorText({ is_error: true, subtype: "error_during_execution", errors: [" a ", "", "b"] })).toBe("a; b");
    expect(resultErrorText({ is_error: true, subtype: "success", result: "API Error: 500" })).toBe("API Error: 500");
    expect(resultErrorText({ is_error: false, subtype: "success", result: "fine" })).toBeUndefined();
  });

  it("matches only the same text", () => {
    const text = resultErrorText(NO_CONVERSATION);
    expect(isEchoOfResultError(`Claude Code returned an error result: ${text}`, text)).toBe(true);
    expect(isEchoOfResultError("Claude Code returned an error result: something else", text)).toBe(false);
    expect(isEchoOfResultError("Claude Code process exited with code 1", text)).toBe(false);
    expect(isEchoOfResultError(`Claude Code returned an error result: ${text}`, undefined)).toBe(false);
  });
});
