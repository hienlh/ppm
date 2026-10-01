import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { CodexAppServerProvider } from "../../../src/providers/codex-app-server/codex-provider.ts";
import { providerProbeStatuses, providerRegistry, retryProviderProbe } from "../../../src/providers/registry.ts";
import { nextProbeDelayMs, stderrReason, type ProviderProbeResult } from "../../../src/providers/provider-probe.ts";

describe("codex availability backoff", () => {
  it("spreads retries out to a 15-minute ceiling and stays there", () => {
    expect(nextProbeDelayMs(1)).toBe(30_000);
    expect(nextProbeDelayMs(2)).toBe(60_000);
    expect(nextProbeDelayMs(3)).toBe(120_000);
    expect(nextProbeDelayMs(4)).toBe(300_000);
    expect(nextProbeDelayMs(5)).toBe(900_000);
    expect(nextProbeDelayMs(40)).toBe(900_000);
  });

  it("treats a count below the first attempt as the first", () => {
    expect(nextProbeDelayMs(0)).toBe(30_000);
  });
});

describe("probe failure reason", () => {
  // Captured from a real cold `bun x` against an unreachable registry — the
  // shape the server logged when Codex went missing after a restart.
  it("keeps the error line out of bun's progress narration", () => {
    const stderr = "Resolving dependencies\nResolved, downloaded and extracted [6]\nerror: ConnectionRefused downloading package manifest @openai/codex";
    expect(stderrReason(stderr)).toBe("error: ConnectionRefused downloading package manifest @openai/codex");
  });

  it("falls back to the last line when nothing announces itself as an error", () => {
    expect(stderrReason("Resolving dependencies\nsomething odd\n\n")).toBe("something odd");
  });

  it("is empty for empty stderr, so the caller can say the exit code instead", () => {
    expect(stderrReason("\n  \n")).toBe("");
  });
});

describe("codex probe retry", () => {
  const spies: Array<{ mockRestore(): void }> = [];

  afterEach(() => {
    for (const spy of spies.splice(0)) spy.mockRestore();
  });

  function probeAnswers(result: ProviderProbeResult) {
    spies.push(spyOn(CodexAppServerProvider.prototype, "probe").mockImplementation(async () => result));
  }

  const codexStatus = () => providerProbeStatuses().find((s) => s.id === "codex");

  // The failure this whole path exists for: bun's manifest refresh during a
  // restart that raced the network. The install is fine; the probe is not.
  it("keeps a network failure scheduled instead of hiding codex until a restart", async () => {
    probeAnswers({
      ok: false,
      retryable: true,
      reason: "error: ConnectionRefused downloading package manifest @openai/codex",
    });

    const status = await retryProviderProbe("codex");

    expect(status.registered).toBe(false);
    expect(status.reason).toContain("ConnectionRefused");
    expect(typeof status.nextProbeAt).toBe("string");
    expect(providerRegistry.get("codex")).toBeUndefined();
    expect(codexStatus()).toEqual(status);
  });

  it("stops asking when bun itself is missing, which retrying cannot fix", async () => {
    probeAnswers({ ok: false, retryable: false, reason: "Could not resolve bun binary. Install Bun or add it to PATH." });

    const status = await retryProviderProbe("codex");

    expect(status.registered).toBe(false);
    expect(status.nextProbeAt).toBeUndefined();
  });

  it("registers on a later attempt, with no restart and nothing left scheduled", async () => {
    const attemptsBefore = codexStatus()?.attempts ?? 0;
    probeAnswers({ ok: true });

    const status = await retryProviderProbe("codex");

    expect(status).toMatchObject({ registered: true, attempts: attemptsBefore + 1 });
    expect(status.nextProbeAt).toBeUndefined();
    expect(status.reason).toBeUndefined();
    // The composer builds its provider chip from this list.
    expect(providerRegistry.list().map((p) => p.id)).toContain("codex");
  });

  it("names the provider it cannot retry", () => {
    expect(() => retryProviderProbe("claude")).toThrow(/no retryable probe/);
  });
});
