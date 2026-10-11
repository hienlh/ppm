import { describe, expect, it } from "bun:test";
import {
  sessionPermissionFromGreeting, shownPermissionMode, storedPermissionToAdopt,
} from "../../../src/web/lib/session-permission";

describe("session permission from the connect greeting", () => {
  it("reads the stored mode and the default, ignoring anything unrecognised", () => {
    expect(sessionPermissionFromGreeting({ permissionMode: "default", defaultPermissionMode: "bypassPermissions" }, "s1"))
      .toEqual({ sessionId: "s1", stored: "default", fallback: "bypassPermissions" });
    expect(sessionPermissionFromGreeting({ permissionMode: "yolo", defaultPermissionMode: 3 }, "s1"))
      .toEqual({ sessionId: "s1", stored: null });
  });

  it("adopts the stored mode only for the chat it describes and not over a fresh pick", () => {
    const server = { sessionId: "s1", stored: "default", fallback: "bypassPermissions" };
    expect(storedPermissionToAdopt(server, "s1", undefined, undefined)).toBe("default");
    expect(storedPermissionToAdopt(server, "s1", "bypassPermissions", undefined)).toBe("default");
    expect(storedPermissionToAdopt(server, "s1", "default", undefined)).toBeNull();
    // The greeting of the chat the tab showed before must not speak for the next one.
    expect(storedPermissionToAdopt(server, "s2", undefined, undefined)).toBeNull();
    expect(storedPermissionToAdopt(server, "s1", "plan", "s1")).toBeNull();
    // A pick made for another chat does not shield this one.
    expect(storedPermissionToAdopt(server, "s1", "plan", "s0")).toBe("default");
    expect(storedPermissionToAdopt({ ...server, stored: null }, "s1", undefined, undefined)).toBeNull();
  });

  it("shows the tab's mode, else the chat's, else nothing", () => {
    const server = { sessionId: "s1", stored: null, fallback: "acceptEdits" };
    expect(shownPermissionMode("plan", server, "s1")).toBe("plan");
    expect(shownPermissionMode(undefined, server, "s1")).toBe("acceptEdits");
    expect(shownPermissionMode(undefined, server, "s2")).toBeUndefined();
    expect(shownPermissionMode(undefined, null, "s1")).toBeUndefined();
  });
});
