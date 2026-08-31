import { describe, it, expect } from "bun:test";
import { isAllowedPath } from "../../../src/services/fs-browse.service.ts";

describe("isAllowedPath — SDK background-command .output exception", () => {
  it("allows macOS /tmp/claude-<uid> layout (lsof reports /private/tmp)", () => {
    expect(
      isAllowedPath("/private/tmp/claude-501/-Users-x-Projects-app/3ef19f1d/tasks/b1fel903t.output"),
    ).toBe(true);
  });

  it("allows older macOS /var/folders temp layout with plain claude dir", () => {
    expect(
      isAllowedPath("/var/folders/73/xx/T/claude/-Users-x-proj/sess/tasks/ab.output"),
    ).toBe(true);
  });

  it("allows Windows Temp\\claude layout", () => {
    expect(
      isAllowedPath("Z:\\Other\\Temp\\claude\\C--Users-x-app\\sess\\tasks\\bs3.output"),
    ).toBe(true);
  });

  it("rejects .output files not under a tasks dir", () => {
    expect(isAllowedPath("/private/tmp/claude-501/x/secret.output")).toBe(false);
  });

  it("rejects non-.output files under claude*/tasks", () => {
    expect(isAllowedPath("/etc/claude-fake/tasks/passwd")).toBe(false);
  });

  it("rejects unresolved traversal segments", () => {
    expect(isAllowedPath("/private/tmp/claude-501/a/tasks/../../../etc/x.output")).toBe(false);
  });
});
