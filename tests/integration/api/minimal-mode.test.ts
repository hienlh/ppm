import { afterEach, describe, expect, test } from "bun:test";
import "../../test-setup.ts";
import { app } from "../../../src/server/index.ts";

const originalArgv = [...process.argv];
afterEach(() => { process.argv = [...originalArgv]; });

describe("minimal server API", () => {
  test("reports runtime mode without authentication", async () => {
    process.argv = originalArgv.filter((arg) => arg !== "--minimal");
    let response = await app.request("/api/info");
    expect((await response.json()).data.minimal_mode).toBe(false);
    process.argv.push("--minimal");
    response = await app.request("/api/info");
    expect(response.status).toBe(200);
    expect((await response.json()).data.minimal_mode).toBe(true);
  });

  test("blocks disabled services before they can start while retaining core API", async () => {
    process.argv.push("--minimal");
    for (const path of ["/api/tunnels", "/api/preview", "/api/db/connections/file/objects", "/api/html-preview", "/api/share-host", "/api/tab-tools-mcp", "/api/db-tools-mcp", "/api/extensions", "/api/schedules", "/api/settings/clawbot", "/api/db", "/api/remote-desktop", "/proxy/v1/models"]) {
      const response = await app.request(path);
      expect(response.status).toBe(403);
      expect((await response.json()).error).toContain("minimal mode");
    }
    for (const path of ["/api/health", "/api/auth/check", "/api/projects"]) {
      expect((await app.request(path)).status).toBe(200);
    }
  });
});
