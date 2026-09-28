import { expect, test, spyOn } from "bun:test";
import { chatRoutes } from "../../../src/server/routes/chat.ts";
import { providerRegistry } from "../../../src/providers/registry.ts";
import { CodexAppServerProvider } from "../../../src/providers/codex-app-server/codex-provider.ts";

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
