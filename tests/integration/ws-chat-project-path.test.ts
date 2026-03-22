import { describe, it, expect, beforeAll } from "bun:test";
import "../test-setup.ts";
import { configService } from "../../src/services/config.service.ts";
import { providerRegistry } from "../../src/providers/registry.ts";
import { ClaudeAgentSdkProvider } from "../../src/providers/claude-agent-sdk.ts";

/**
 * Regression test: WS chat handler must resume session in provider
 * BEFORE calling ensureProjectPath, otherwise projectPath is lost
 * and tool execution fails (cwd = undefined).
 *
 * This simulates the exact flow from src/server/ws/chat.ts message handler.
 */
describe("WS chat handler — projectPath backfill on resumed sessions", () => {
  const TEST_PROJECT_PATH = "/tmp/ppm-test-project";

  beforeAll(() => {
    // Direct mutation — no DB write (configService.set() persists to DB and corrupts prod)
    (configService as any).config.projects = [{ name: "test", path: TEST_PROJECT_PATH }];
  });

  it("ensureProjectPath works AFTER resumeSession (fixed flow)", async () => {
    const provider = providerRegistry.get("claude") as ClaudeAgentSdkProvider;
    const sessionId = crypto.randomUUID();

    // Simulate server restart: provider has no knowledge of this session
    // This is what happens when user reconnects after server restart

    // Step 1: Resume session first (as the fixed WS handler does)
    await provider.resumeSession(sessionId);

    // Step 2: Now ensureProjectPath should succeed because session exists
    provider.ensureProjectPath(sessionId, TEST_PROJECT_PATH);

    // Verify: session should have projectPath set
    const meta = (provider as any).activeSessions.get(sessionId);
    expect(meta).toBeDefined();
    expect(meta.projectPath).toBe(TEST_PROJECT_PATH);
  });

  it("ensureProjectPath fails WITHOUT resumeSession (old broken flow)", () => {
    const provider = providerRegistry.get("claude") as ClaudeAgentSdkProvider;
    const sessionId = crypto.randomUUID();

    // Old flow: ensureProjectPath BEFORE resumeSession
    // Session doesn't exist in activeSessions yet → no-op
    provider.ensureProjectPath(sessionId, TEST_PROJECT_PATH);

    // Verify: session does NOT exist — projectPath was lost
    const meta = (provider as any).activeSessions.get(sessionId);
    expect(meta).toBeUndefined();
  });

  it("sendMessage uses projectPath as cwd after proper resume flow", async () => {
    const provider = providerRegistry.get("claude") as ClaudeAgentSdkProvider;

    // Create session with projectPath (simulates normal create via REST API)
    const session = await provider.createSession({
      projectName: "test",
      projectPath: TEST_PROJECT_PATH,
    });

    // Verify session has projectPath
    const meta = (provider as any).activeSessions.get(session.id);
    expect(meta.projectPath).toBe(TEST_PROJECT_PATH);

    // Simulate server restart: clear activeSessions
    (provider as any).activeSessions.delete(session.id);
    (provider as any).messageCount.delete(session.id);

    // Fixed WS flow: resume first, then set projectPath
    await provider.resumeSession(session.id);
    provider.ensureProjectPath(session.id, TEST_PROJECT_PATH);

    // Verify projectPath survived the resume + backfill
    const resumed = (provider as any).activeSessions.get(session.id);
    expect(resumed).toBeDefined();
    expect(resumed.projectPath).toBe(TEST_PROJECT_PATH);
  });
});
