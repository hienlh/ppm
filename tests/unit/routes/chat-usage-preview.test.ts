import { expect, test, spyOn } from "bun:test";
import { chatRoutes } from "../../../src/server/routes/chat.ts";
import { providerRegistry } from "../../../src/providers/registry.ts";
import { CodexAppServerProvider } from "../../../src/providers/codex-app-server/codex-provider.ts";
import * as claudeUsageService from "../../../src/services/claude-usage.service.ts";

test("usage endpoint forwards the new tab's claimed account without creating a session", async () => {
  const provider = new CodexAppServerProvider();
  const getUsage = spyOn(provider, "getUsage").mockResolvedValue({ activeAccountId: "picked", fiveHour: 0, sevenDay: 0.57 });
  const lookup = spyOn(providerRegistry, "get").mockReturnValue(provider);
  try {
    const response = await chatRoutes.request("http://localhost/usage?providerId=codex&accountId=picked");
    expect(response.status).toBe(200);
    expect(getUsage).toHaveBeenCalledWith(undefined, "picked");
    expect((await response.json() as any).data).toMatchObject({ activeAccountId: "picked", fiveHour: 0, sevenDay: 0.57 });
  } finally {
    lookup.mockRestore();
    getUsage.mockRestore();
  }
});

/**
 * A new Claude tab has claimed an account (via `/chat/prepare` or `/api/accounts/pick`) but
 * has not created a session yet, so there is nothing to bind. The usage chip still has to
 * show the account the tab will actually run on, which means `?accountId=` must be honoured
 * for Claude too — but only in the absence of `?session=`, whose binding stays authoritative.
 */
test("usage endpoint honors accountId for Claude when there is no session", async () => {
  const getCachedUsage = spyOn(claudeUsageService, "getCachedUsage")
    .mockReturnValue({ activeAccountId: "claude-picked", activeAccountLabel: "Picked Claude" } as ReturnType<typeof claudeUsageService.getCachedUsage>);
  try {
    const response = await chatRoutes.request("http://localhost/usage?accountId=claude-picked");
    expect(response.status).toBe(200);
    expect(getCachedUsage).toHaveBeenCalledWith("claude-picked");
    const json = await response.json() as any;
    expect(json.data.activeAccountId).toBe("claude-picked");
    expect(json.data.activeAccountLabel).toBe("Picked Claude");
  } finally {
    getCachedUsage.mockRestore();
  }
});

test("usage endpoint ignores accountId for Claude once a session binding exists", async () => {
  const getCachedUsage = spyOn(claudeUsageService, "getCachedUsage")
    .mockReturnValue({ activeAccountId: "session-bound" } as ReturnType<typeof claudeUsageService.getCachedUsage>);
  try {
    // No session_metadata row exists for "some-session" in the test DB, so the session's
    // bound account resolves to null — proving the route reads the binding, not the query
    // param, once a session id is present at all.
    const response = await chatRoutes.request("http://localhost/usage?session=some-session&accountId=claude-picked");
    expect(response.status).toBe(200);
    expect(getCachedUsage).toHaveBeenCalledWith(undefined);
  } finally {
    getCachedUsage.mockRestore();
  }
});
