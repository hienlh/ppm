import { describe, expect, it } from "bun:test";
import { permissionModeToCodex } from "../../../src/providers/codex-app-server/codex-permission-map.ts";

const MODES = ["bypassPermissions", "acceptEdits", "default", "plan", "nonsense", undefined];

describe("permissionModeToCodex for design sessions", () => {
  it("asks before untrusted commands in a design session's acceptEdits", () => {
    expect(permissionModeToCodex("acceptEdits", { designSession: true }))
      .toEqual({ sandbox: "workspace-write", approvalPolicy: "untrusted" });
  });

  it("maps every other mode exactly as an ordinary session does", () => {
    for (const mode of MODES) {
      if (mode === "acceptEdits") continue;
      expect(permissionModeToCodex(mode, { designSession: true })).toEqual(permissionModeToCodex(mode));
    }
  });

  it("leaves ordinary sessions untouched, with or without the option", () => {
    for (const mode of MODES) {
      expect(permissionModeToCodex(mode, { designSession: false })).toEqual(permissionModeToCodex(mode));
      expect(permissionModeToCodex(mode, {})).toEqual(permissionModeToCodex(mode));
    }
    expect(permissionModeToCodex("acceptEdits")).toEqual({ sandbox: "workspace-write", approvalPolicy: "on-request" });
  });
});
