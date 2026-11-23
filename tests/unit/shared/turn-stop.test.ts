/** The words the stop bar and the "Chat stopped" notification use for each kind of stop. */
import { describe, it, expect } from "bun:test";
import { describeTurnStop, isCliSignedOutStop, isSessionMissingStop } from "../../../src/shared/turn-stop.ts";
import { cliSignedOutMessage, sessionMissingMessage } from "../../../src/providers/claude-session-missing.ts";

describe("describeTurnStop", () => {
  it("says a conversation Claude Code lost is gone, not that an error stopped it", () => {
    const stop = { message: sessionMissingMessage("off"), subtype: "error_session_missing", at: 0 };
    expect(isSessionMissingStop(stop)).toBe(true);
    const { title, detail } = describeTurnStop(stop);
    expect(title).toBe("Claude Code no longer has this chat's history");
    expect(detail).toContain("next message starts a new session");
  });

  it("recognises a signed-out CLI by the provider's own wording", () => {
    const stop = { message: cliSignedOutMessage("Not logged in · Please run /login"), subtype: "error_during_execution", at: 0 };
    expect(isCliSignedOutStop(stop)).toBe(true);
    expect(isSessionMissingStop(stop)).toBe(false);
    expect(describeTurnStop(stop).title).toBe("Stopped: Claude Code on this computer is signed out");
  });

  it("names the step limit a Max Turns stop hit, and where it is set", () => {
    const { title, detail } = describeTurnStop({
      message: "Agent reached maximum turn limit.\nReached maximum number of turns (500)",
      subtype: "error_max_turns",
      at: 0,
    });
    expect(title).toBe("Stopped after 500 steps (Max Turns)");
    expect(detail).toContain("Settings → AI Provider");
  });

  it("still names Max Turns when the limit is missing from the message", () => {
    expect(describeTurnStop({ message: "Agent reached maximum turn limit.", subtype: "error_max_turns", at: 0 }).title)
      .toBe("Stopped at the Max Turns limit");
  });

  it("uses an error's first line as the headline and the rest as detail", () => {
    expect(describeTurnStop({
      message: "Agent encountered an error during execution.\nAPI Error: 500\n\nHint: Network connectivity issue.",
      subtype: "error_during_execution",
      at: 0,
    })).toEqual({
      title: "Stopped: Agent encountered an error during execution",
      detail: "API Error: 500 Hint: Network connectivity issue.",
    });
    expect(describeTurnStop({ message: "  ", at: 0 })).toEqual({ title: "Stopped by an error", detail: null });
  });
});
