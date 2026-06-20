import { describe, it, expect } from "bun:test";
import { permissionModeToCodex } from "../../../src/providers/codex-app-server/codex-permission-map.ts";

describe("permissionModeToCodex", () => {
  it("maps bypassPermissions → Full access", () => {
    expect(permissionModeToCodex("bypassPermissions")).toEqual({ sandbox: "danger-full-access", approvalPolicy: "never" });
  });
  it("maps acceptEdits → workspace-write + on-request", () => {
    expect(permissionModeToCodex("acceptEdits")).toEqual({ sandbox: "workspace-write", approvalPolicy: "on-request" });
  });
  it("maps default → read-only + on-request", () => {
    expect(permissionModeToCodex("default")).toEqual({ sandbox: "read-only", approvalPolicy: "on-request" });
  });
  it("maps plan → read-only + never", () => {
    expect(permissionModeToCodex("plan")).toEqual({ sandbox: "read-only", approvalPolicy: "never" });
  });
  it("falls back to bypassPermissions for unknown / undefined", () => {
    expect(permissionModeToCodex("nonsense")).toEqual({ sandbox: "danger-full-access", approvalPolicy: "never" });
    expect(permissionModeToCodex(undefined)).toEqual({ sandbox: "danger-full-access", approvalPolicy: "never" });
  });
});
