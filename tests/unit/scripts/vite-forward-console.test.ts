import { afterEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { resolveConfig } from "vite";

const REPO = join(import.meta.dir, "../../..");
const AGENT_ENV = "CLAUDECODE";
const saved = process.env[AGENT_ENV];

afterEach(() => {
  if (saved === undefined) delete process.env[AGENT_ENV];
  else process.env[AGENT_ENV] = saved;
});

const resolveServe = (configFile: string | false) =>
  resolveConfig({ configFile, root: REPO, logLevel: "silent" }, "serve");

describe("the dev server's console forwarding", () => {
  it("is switched on by Vite itself when an agent started the server", async () => {
    // Nothing asks for it, which is why it went unnoticed: Vite reads the agent's
    // environment and enables it by default.
    process.env[AGENT_ENV] = "1";
    const config = await resolveServe(false);
    expect(config.server.forwardConsole.enabled).toBe(true);
    expect(config.server.forwardConsole.unhandledErrors).toBe(true);
  });

  it("stays off in PPM's config even then", async () => {
    process.env[AGENT_ENV] = "1";
    const config = await resolveServe(join(REPO, "vite.config.ts"));
    expect(config.server.forwardConsole.enabled).toBe(false);
    expect(config.server.forwardConsole.unhandledErrors).toBe(false);
  });
});
