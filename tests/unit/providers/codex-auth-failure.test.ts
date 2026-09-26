import { describe, it, expect } from "bun:test";
import { isCodexAuthFailure, codexErrorText } from "../../../src/providers/codex-app-server/codex-auth-failure.ts";

/** Captured from a live app-server on an account whose ChatGPT login was revoked. */
const RETRY_NOTICE = {
  error: {
    message: "Reconnecting... 2/5",
    codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } },
    additionalDetails: "workspace routing discovery unauthorized (401)",
    misalignment: null,
  },
  willRetry: true,
  threadId: "t", turnId: "u",
};
const FINAL_ERROR = {
  error: { message: "workspace routing discovery unauthorized (401)", codexErrorInfo: "other", additionalDetails: null },
  willRetry: false,
};
/** What the same account's quota read throws. */
const USAGE_READ = 'failed to fetch codex rate limits: GET https://chatgpt.com/backend-api/wham/usage failed: 401 Unauthorized; content-type=text/plain; body={ "error": { "message": "Encountered invalidated oauth token for user, failing request", "code": "token_revoked" } }';

describe("codex auth-failure detection", () => {
  it("sees the 401 in a retry notice's details, not its headline", () => {
    expect(isCodexAuthFailure("Reconnecting... 2/5")).toBe(false);
    expect(isCodexAuthFailure(codexErrorText(RETRY_NOTICE))).toBe(true);
  });

  it("recognises the final error and the quota read", () => {
    expect(isCodexAuthFailure(codexErrorText(FINAL_ERROR))).toBe(true);
    expect(isCodexAuthFailure(USAGE_READ)).toBe(true);
  });

  it("recognises codex's sign-in wording", () => {
    expect(isCodexAuthFailure("Your access token could not be refreshed because your refresh token was revoked. Please log out and sign in again.")).toBe(true);
  });

  it("leaves unrelated failures alone", () => {
    expect(isCodexAuthFailure("stream disconnected before completion")).toBe(false);
    expect(isCodexAuthFailure("You've hit your usage limit. Try again at 4:21 PM.")).toBe(false);
    expect(isCodexAuthFailure("line 401 of the file has a syntax error")).toBe(false);
    expect(isCodexAuthFailure("unexpected status 500 Internal Server Error")).toBe(false);
    expect(isCodexAuthFailure("")).toBe(false);
  });

  it("joins message and details, skipping what is missing", () => {
    expect(codexErrorText(RETRY_NOTICE)).toBe("Reconnecting... 2/5 — workspace routing discovery unauthorized (401)");
    expect(codexErrorText({ message: "flat" })).toBe("flat");
    expect(codexErrorText(null)).toBe("");
  });
});
