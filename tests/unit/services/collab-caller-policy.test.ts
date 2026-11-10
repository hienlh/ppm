/**
 * Which session tools a caller may use, by kind of caller and whether its turn is unattended: an
 * ordinary session follows its settings, the PPM Assistant asks unless it messages a manager chat,
 * and an unattended Assistant turn may create nothing and message manager chats only.
 */
import { describe, expect, it } from "bun:test";
import { collabToolPolicy } from "../../../src/services/session-collab/collab-caller-policy.ts";
import { UNATTENDED_TURN_REFUSAL } from "../../../src/services/chat-control/chat-control.ts";

const session = { kind: "session" as const, unattended: false };
const assistant = { kind: "assistant" as const, unattended: false };
const unattended = { kind: "assistant" as const, unattended: true };

describe("collabToolPolicy", () => {
  it("leaves an ordinary session to its settings for every tool", () => {
    for (const tool of ["create_session", "send_to_session", "session_status"]) {
      expect(collabToolPolicy(session, tool)).toEqual({ allowed: true, ask: "settings" });
    }
  });

  it("makes the Assistant ask for every create and message, and reads status freely", () => {
    expect(collabToolPolicy(assistant, "create_session")).toEqual({ allowed: true, ask: "always" });
    expect(collabToolPolicy(assistant, "send_to_session")).toEqual({ allowed: true, ask: "always" });
    expect(collabToolPolicy(assistant, "session_status")).toEqual({ allowed: true, ask: "settings" });
  });

  it("refuses creates in an unattended Assistant turn, and leaves its messages to the send (managers only)", () => {
    expect(collabToolPolicy(unattended, "create_session")).toEqual({ allowed: false, message: UNATTENDED_TURN_REFUSAL });
    expect(collabToolPolicy(unattended, "send_to_session")).toEqual({ allowed: true, ask: "always" });
    expect(collabToolPolicy(unattended, "session_status")).toEqual({ allowed: true, ask: "settings" });
  });

  it("refuses a tool it does not know", () => {
    expect(collabToolPolicy(session, "delete_session").allowed).toBe(false);
  });
});
