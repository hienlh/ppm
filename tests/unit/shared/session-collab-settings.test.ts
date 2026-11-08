import { describe, expect, it } from "bun:test";
import {
  parseSessionCollabPatch, resolveSessionCollabSettings, SESSION_COLLAB_DEFAULTS,
} from "../../../src/shared/session-collab-settings.ts";
import {
  isPermissionEscalation, permissionRank, sessionCollabAnswersFor, sessionCollabApprovalInput, SESSION_COLLAB_APPROVAL,
} from "../../../src/shared/session-collab.ts";
import { VALID_PERMISSION_MODES } from "../../../src/types/config.ts";

describe("session collaboration settings", () => {
  it("fills defaults and clamps whatever was stored", () => {
    expect(resolveSessionCollabSettings(undefined)).toEqual({ ...SESSION_COLLAB_DEFAULTS });
    expect(resolveSessionCollabSettings("junk")).toEqual({ ...SESSION_COLLAB_DEFAULTS });
    expect(resolveSessionCollabSettings({
      askBeforeCreate: false, maxDepth: 99, maxAutoMessagesPerPair: 0, maxRunningSpawned: 7.6, waitTimeoutMinutes: "5",
    })).toEqual({ askBeforeCreate: false, maxDepth: 5, maxAutoMessagesPerPair: 1, maxRunningSpawned: 8, waitTimeoutMinutes: 10 });
  });

  it("accepts a patch of known fields, clamped, and refuses anything else", () => {
    expect(parseSessionCollabPatch({ maxDepth: 0, waitTimeoutMinutes: 120, askBeforeCreate: true }))
      .toEqual({ ok: true, patch: { maxDepth: 1, waitTimeoutMinutes: 60, askBeforeCreate: true } });
    expect(parseSessionCollabPatch({ maxRunningSpawned: 21 })).toEqual({ ok: true, patch: { maxRunningSpawned: 20 } });
    expect(parseSessionCollabPatch({ maxAutoMessagesPerPair: 500 })).toEqual({ ok: true, patch: { maxAutoMessagesPerPair: 200 } });
    expect(parseSessionCollabPatch({ maxDepth: "3" }).ok).toBe(false);
    expect(parseSessionCollabPatch({ maxDepth: Number.NaN }).ok).toBe(false);
    expect(parseSessionCollabPatch({ askBeforeCreate: 1 }).ok).toBe(false);
    expect(parseSessionCollabPatch({ somethingElse: true }).ok).toBe(false);
    expect(parseSessionCollabPatch([]).ok).toBe(false);
  });
});

describe("session collaboration contracts", () => {
  it("ranks every permission mode PPM has, from plan to bypass", () => {
    const ranked = [...VALID_PERMISSION_MODES].sort((a, b) => permissionRank(a) - permissionRank(b));
    expect(ranked).toEqual(["plan", "default", "acceptEdits", "bypassPermissions"]);
    expect(permissionRank("something-new")).toBe(permissionRank("bypassPermissions"));
    expect(isPermissionEscalation("default", "bypassPermissions")).toBe(true);
    expect(isPermissionEscalation("acceptEdits", "plan")).toBe(false);
    expect(isPermissionEscalation("default", "default")).toBe(false);
    expect(isPermissionEscalation("default", undefined)).toBe(true);
  });

  it("narrows approval inputs and the answers each card offers", () => {
    expect(sessionCollabApprovalInput(SESSION_COLLAB_APPROVAL, { kind: "escalation" })).toMatchObject({ kind: "escalation" });
    expect(sessionCollabApprovalInput("Bash", { kind: "create" })).toBeNull();
    expect(sessionCollabApprovalInput(SESSION_COLLAB_APPROVAL, { kind: "other" })).toBeNull();
    expect(sessionCollabAnswersFor("pair_limit")).toEqual(["allow_once", "deny"]);
    expect(sessionCollabAnswersFor("escalation")).toEqual(["allow_once", "allow_session", "deny"]);
  });
});
