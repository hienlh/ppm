import { describe, expect, it } from "bun:test";
import {
  buildThreadParams,
  isUnknownDeveloperInstructionsError,
  requestWithInstructionsFallback,
  type CodexThreadParams,
} from "../../../src/providers/codex-app-server/codex-thread-params.ts";

const permission = { sandbox: "workspace-write", approvalPolicy: "untrusted" } as const;

describe("buildThreadParams", () => {
  it("sends exactly what an ordinary session always sent", () => {
    expect(buildThreadParams({
      cwd: "/p", permission: { sandbox: "danger-full-access", approvalPolicy: "never" },
    })).toEqual({ cwd: "/p", sandbox: "danger-full-access", approvalPolicy: "never" });
  });

  it("carries model and provider config overrides", () => {
    expect(buildThreadParams({
      cwd: "/p", permission, model: "gpt-6", configOverrides: { config: { model_context_window: 1000 } },
    })).toEqual({
      config: { model_context_window: 1000 }, cwd: "/p", sandbox: "workspace-write",
      approvalPolicy: "untrusted", model: "gpt-6",
    });
  });

  it("adds developerInstructions only when there is text", () => {
    expect(buildThreadParams({ cwd: "/p", permission, developerInstructions: "  " }))
      .not.toHaveProperty("developerInstructions");
    expect(buildThreadParams({ cwd: "/p", permission, developerInstructions: "# Design mode\n" }).developerInstructions)
      .toBe("# Design mode");
  });
});

describe("requestWithInstructionsFallback", () => {
  const withInstructions: CodexThreadParams = { cwd: "/p", developerInstructions: "# Design mode" };

  it("passes the params straight through when the request succeeds", async () => {
    const seen: CodexThreadParams[] = [];
    const result = await requestWithInstructionsFallback(withInstructions, async (p) => { seen.push(p); return "ok"; });
    expect(result).toBe("ok");
    expect(seen).toEqual([withInstructions]);
  });

  it("retries once without the field when an older codex rejects it, and logs", async () => {
    const seen: CodexThreadParams[] = [];
    const logs: string[] = [];
    const result = await requestWithInstructionsFallback(withInstructions, async (p) => {
      seen.push(p);
      if (p.developerInstructions) throw new Error("unknown field `developerInstructions`");
      return "started";
    }, (m) => logs.push(m));
    expect(result).toBe("started");
    expect(seen).toHaveLength(2);
    expect(seen[1]).toEqual({ cwd: "/p" });
    expect(logs).toHaveLength(1);
  });

  it("does not retry an unrelated failure", async () => {
    let calls = 0;
    await expect(requestWithInstructionsFallback(withInstructions, async () => {
      calls++;
      throw new Error("no rollout found for thread id x");
    }, () => {})).rejects.toThrow("no rollout found");
    expect(calls).toBe(1);
  });

  it("does not retry when no instructions were sent", async () => {
    let calls = 0;
    await expect(requestWithInstructionsFallback({ cwd: "/p" }, async () => {
      calls++;
      throw new Error("unknown field `developerInstructions`");
    }, () => {})).rejects.toThrow();
    expect(calls).toBe(1);
  });
});

describe("isUnknownDeveloperInstructionsError", () => {
  it("recognises the field being refused, and nothing else", () => {
    expect(isUnknownDeveloperInstructionsError(new Error("Invalid params: unknown field `developerInstructions`"))).toBe(true);
    expect(isUnknownDeveloperInstructionsError(new Error("unknown field `model`"))).toBe(false);
    expect(isUnknownDeveloperInstructionsError(new Error("timeout"))).toBe(false);
  });
});
