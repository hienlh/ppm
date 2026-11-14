import { describe, it, expect, beforeEach } from "bun:test";
import {
  codexLoginTag, codexStderrLogLine, _resetCodexStderrLogForTesting,
} from "../../../src/providers/codex-app-server/codex-stderr-log.ts";

const REFRESH = (t: string) =>
  `${t} ERROR codex_login::auth::manager: Failed to refresh Token: access token could not be refreshed. Please log out and sign in again.`;

describe("codex stderr log lines", () => {
  beforeEach(_resetCodexStderrLogForTesting);

  it("names the login the app-server runs on", () => {
    expect(codexLoginTag(undefined)).toBe("ambient");
    expect(codexLoginTag("C:\\Users\\x\\.ppm\\codex-accounts\\536defe4-e915-4cd3-9eab-4a64f5a89022")).toBe("536defe4");
    expect(codexLoginTag("/home/x/.ppm/codex-accounts/26447b3b-a15a-443b-8c9b-befc1864ab28/")).toBe("26447b3b");
    const out = codexStderrLogLine("536defe4", REFRESH("2026-11-14T13:46:02.779305Z"))!;
    expect(out.level).toBe("warn");
    expect(out.message.startsWith("stderr account=536defe4: ")).toBe(true);
  });

  it("logs one refresh failure loudly per account per hour, however many processes repeat it", () => {
    const t0 = Date.parse("2026-11-14T13:00:00Z");
    // Six copies from one process, then the next sweep's process five minutes later.
    const levels = [0, 1, 2, 3, 4, 5].map((i) =>
      codexStderrLogLine("536defe4", REFRESH(`2026-11-14T13:00:0${i}.1Z`), t0 + i)!.level);
    levels.push(codexStderrLogLine("536defe4", REFRESH("2026-11-14T13:05:00.1Z"), t0 + 5 * 60_000)!.level);
    expect(levels).toEqual(["warn", "debug", "debug", "debug", "debug", "debug", "debug"]);

    // Another account's identical failure is its own news.
    expect(codexStderrLogLine("26447b3b", REFRESH("2026-11-14T13:05:01Z"), t0 + 5 * 60_000)!.level).toBe("warn");

    // An hour on it is said again, with how many were folded.
    const again = codexStderrLogLine("536defe4", REFRESH("2026-11-14T14:00:01Z"), t0 + 60 * 60_000 + 1)!;
    expect(again.level).toBe("warn");
    expect(again.message).toContain("seen 6 more times since 2026-11-14T13:00:00.000Z");
  });

  it("never folds a chat's errors, which may be the only record of why that chat failed", () => {
    const t0 = Date.parse("2026-11-14T13:00:00Z");
    expect(codexStderrLogLine("26447b3b", REFRESH("x"), t0)!.level).toBe("warn");
    expect(codexStderrLogLine("26447b3b", REFRESH("y"), t0 + 1, false)!.level).toBe("warn");
    expect(codexStderrLogLine("26447b3b", REFRESH("z"), t0 + 2, false)!.level).toBe("warn");
  });

  it("keeps codex's own level for quiet lines and drops noise", () => {
    expect(codexStderrLogLine("ambient", "2026-11-14T13:00:00Z INFO codex_core: started")!.level).toBe("debug");
    expect(codexStderrLogLine("ambient", "   ")).toBeNull();
    expect(codexStderrLogLine("ambient", "(node) Warning: something")).toBeNull();
    // An untagged line that reads like a failure is still loud.
    expect(codexStderrLogLine("ambient", "panic: boom")!.level).toBe("warn");
  });
});
