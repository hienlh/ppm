import { describe, it, expect, beforeEach } from "bun:test";
import { backgroundShellRegistry } from "../../../src/services/background-shell-registry.ts";

const S = "session-A";

describe("backgroundShellRegistry", () => {
  beforeEach(() => {
    backgroundShellRegistry.clearSession(S);
    backgroundShellRegistry.clearSession("session-B");
  });

  it("registers a shell with defaults and lists it", () => {
    backgroundShellRegistry.register(S, {
      shellId: "abc123",
      command: "bun dev",
      outputPath: "/tmp/claude/x/tasks/abc123.output",
      toolUseId: "tu_1",
    });
    const list = backgroundShellRegistry.list(S);
    expect(list).toHaveLength(1);
    expect(list[0]!.status).toBe("running");
    expect(list[0]!.shellId).toBe("abc123");
    expect(typeof list[0]!.startedAt).toBe("number");
  });

  it("preserves startedAt and command on re-register (upsert)", () => {
    backgroundShellRegistry.register(S, { shellId: "abc", command: "bun dev", outputPath: "/p/abc.output", toolUseId: "tu" });
    const first = backgroundShellRegistry.get(S, "abc")!;
    backgroundShellRegistry.register(S, { shellId: "abc", command: "", outputPath: "", toolUseId: "" });
    const second = backgroundShellRegistry.get(S, "abc")!;
    expect(second.startedAt).toBe(first.startedAt);
    expect(second.command).toBe("bun dev");
    expect(second.outputPath).toBe("/p/abc.output");
  });

  it("setStatus flips status and returns false for unknown shell", () => {
    backgroundShellRegistry.register(S, { shellId: "abc", command: "x", outputPath: "/p.output", toolUseId: "t" });
    expect(backgroundShellRegistry.setStatus(S, "abc", "stopping")).toBe(true);
    expect(backgroundShellRegistry.get(S, "abc")!.status).toBe("stopping");
    expect(backgroundShellRegistry.setStatus(S, "missing", "stopped")).toBe(false);
  });

  it("markAllStopped stops every shell in a session", () => {
    backgroundShellRegistry.register(S, { shellId: "a", command: "x", outputPath: "/a.output", toolUseId: "t1" });
    backgroundShellRegistry.register(S, { shellId: "b", command: "y", outputPath: "/b.output", toolUseId: "t2" });
    backgroundShellRegistry.markAllStopped(S);
    expect(backgroundShellRegistry.list(S).every((s) => s.status === "stopped")).toBe(true);
  });

  it("isolates sessions and clears them independently", () => {
    backgroundShellRegistry.register(S, { shellId: "a", command: "x", outputPath: "/a.output", toolUseId: "t" });
    backgroundShellRegistry.register("session-B", { shellId: "b", command: "y", outputPath: "/b.output", toolUseId: "t" });
    backgroundShellRegistry.clearSession(S);
    expect(backgroundShellRegistry.list(S)).toHaveLength(0);
    expect(backgroundShellRegistry.list("session-B")).toHaveLength(1);
  });
});
