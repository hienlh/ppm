import { describe, it, expect } from "bun:test";
import { decisionFor, isApprovalMethod } from "../../../src/providers/codex-app-server/codex-approval-decision.ts";

describe("decisionFor", () => {
  it("commandExecution: approve / decline / cancel", () => {
    expect(decisionFor("item/commandExecution/requestApproval", true)).toEqual({ decision: "accept" });
    expect(decisionFor("item/commandExecution/requestApproval", false)).toEqual({ decision: "decline" });
    expect(decisionFor("item/commandExecution/requestApproval", false, true)).toEqual({ decision: "cancel" });
  });

  it("fileChange: approve / decline", () => {
    expect(decisionFor("item/fileChange/requestApproval", true)).toEqual({ decision: "accept" });
    expect(decisionFor("item/fileChange/requestApproval", false)).toEqual({ decision: "decline" });
  });

  it("legacy execCommandApproval / applyPatchApproval use ReviewDecision", () => {
    expect(decisionFor("execCommandApproval", true)).toEqual({ decision: "approved" });
    expect(decisionFor("execCommandApproval", false)).toEqual({ decision: "denied" });
    expect(decisionFor("applyPatchApproval", true)).toEqual({ decision: "approved" });
    expect(decisionFor("applyPatchApproval", false)).toEqual({ decision: "denied" });
  });

  it("never emits object/amendment variants (MVP string-only)", () => {
    for (const m of ["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "execCommandApproval", "applyPatchApproval"] as const) {
      const d = decisionFor(m, true) as { decision: unknown };
      expect(typeof d.decision).toBe("string");
    }
  });
});

describe("isApprovalMethod", () => {
  it("recognizes the 4 decision-bearing methods", () => {
    expect(isApprovalMethod("item/commandExecution/requestApproval")).toBe(true);
    expect(isApprovalMethod("item/fileChange/requestApproval")).toBe(true);
    expect(isApprovalMethod("execCommandApproval")).toBe(true);
    expect(isApprovalMethod("applyPatchApproval")).toBe(true);
  });
  it("excludes permissions + userInput (different response shapes)", () => {
    expect(isApprovalMethod("item/permissions/requestApproval")).toBe(false);
    expect(isApprovalMethod("item/tool/requestUserInput")).toBe(false);
  });
});
