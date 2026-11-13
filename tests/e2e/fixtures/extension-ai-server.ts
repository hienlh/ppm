/** API-only fixture for the extension AI e2e: a disposable PPM server whose one provider is
 * scripted (`extension-ai-provider.ts`), so no real model, CLI or account is ever reached. The
 * e2e dev-links a probe extension through the real `/api/extensions/dev-link` route and runs
 * its commands through `/__ext-test/command`, which calls the extension host exactly as the
 * extensions socket does when a browser runs a command. Requires an isolated home and an empty
 * PPM directory; refuses the production ones.
 */
import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";

const canonical = (path: string) => realpathSync(path).replace(/\\/g, "/").toLowerCase();
const ppmHome = process.env.PPM_HOME, sandboxHome = process.env.HOME;
const profile = process.env.USERPROFILE, realHomePath = process.env.PPM_EXT_TEST_REAL_HOME;
if (!ppmHome || !sandboxHome || !profile || !realHomePath) throw new Error("Fixture requires isolated PPM_HOME, HOME, USERPROFILE and the parent's real home.");
const realHome = canonical(realHomePath), privateHome = canonical(sandboxHome), privatePpm = canonical(ppmHome);
if (privateHome === realHome || canonical(profile) !== privateHome || privatePpm === realHome ||
    privatePpm === `${realHome}/.ppm` || privatePpm.startsWith(`${realHome}/.ppm/`)) {
  throw new Error("Refusing the production home or PPM directory");
}
if (existsSync(resolve(ppmHome, "ppm.db"))) throw new Error("Fixture requires an empty PPM_HOME");
if (process.argv.includes("__serve__") || process.env.PPM_ALLOW_PROD_DB) throw new Error("Production flags are forbidden");
const port = Number(process.env.PPM_EXT_TEST_PORT);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid fixture port");
for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY", "CODEX_API_KEY", "CURSOR_API_KEY"]) delete process.env[key];
process.env.CLAUDE_CONFIG_DIR = resolve(sandboxHome, ".claude");
process.env.CODEX_HOME = resolve(sandboxHome, ".codex");

// Import services only after validating environment isolation.
const { configService } = await import("../../../src/services/config.service");
configService.load();
configService.set("auth", { ...configService.get("auth"), enabled: false });
configService.set("host", "127.0.0.1");
configService.set("port", port);
configService.set("ai", {
  default_provider: "claude", new_chat_provider_mode: "default", share_provider_context: false,
  providers: { claude: { type: "mock", permission_mode: "bypassPermissions" } },
});

const { ExtensionAiScriptedProvider, records } = await import("./extension-ai-provider");
const { setServerListenAddress } = await import("../../../src/services/server-listen-address");
const { providerRegistry } = await import("../../../src/providers/registry");
const claude = new ExtensionAiScriptedProvider();
const providers = [claude];
providerRegistry.register(claude as never);
// Keep the imported production provider instances unreachable, including aggregate routes.
providerRegistry.get = ((id: string) => providers.find((p) => p.id === id)) as typeof providerRegistry.get;
providerRegistry.list = () => providers.map((p) => ({ id: p.id, name: p.name }));
providerRegistry.listAll = providerRegistry.list;
providerRegistry.getDefault = (() => claude) as typeof providerRegistry.getDefault;

const { app } = await import("../../../src/server/index");
const { extensionService } = await import("../../../src/services/extension.service");

const json = (body: unknown, status = 200) => Response.json(body, { status });

/** Runs one of the probe's commands the way `/ws/extensions` does for a browser, with room for a turn. */
async function runCommand(req: Request): Promise<Response> {
  const { command, args = [] } = await req.json() as { command: string; args?: unknown[] };
  const rpc = extensionService["rpc"];
  if (!rpc) return json({ ok: false, error: "extension host not running" }, 503);
  const answer = await rpc.sendRequestWithTimeout<{ ok: boolean; result?: unknown; error?: string }>("ext:command:execute", 90_000, [command, ...args]);
  return json(answer);
}

const server = Bun.serve({
  hostname: "127.0.0.1", port,
  fetch(req, instance) {
    const url = new URL(req.url);
    if (url.pathname === "/__ext-test/records") return json(records);
    if (url.pathname === "/__ext-test/command" && req.method === "POST") return runCommand(req);
    if (/^\/api\/(?:accounts|tunnels?|preview|upgrade|codex-accounts|proxy|mcp|remote-desktop)(?:\/|$)/.test(url.pathname) ||
        /^\/api\/settings\/(?:telegram|clawbot|ppmbot)/.test(url.pathname)) return new Response("Disabled in fixture", { status: 403 });
    if (!url.pathname.startsWith("/api/")) return new Response("API-only fixture", { status: 404 });
    return app.fetch(req, instance);
  },
});
// What `src/server/index.ts` records once it listens: the ext-mcp URL handed to a turn is built from it.
setServerListenAddress(server.port ?? port, "127.0.0.1");
async function shutdown() {
  await extensionService.shutdown().catch(() => {});
  server.stop(true);
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
console.log(`Extension-AI fixture ready at http://127.0.0.1:${server.port}; scripted provider only.`);
