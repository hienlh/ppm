/**
 * Integration tests for Cloud WebSocket client (Phase 4).
 *
 * Tests:
 * - Auth message sent on connect
 * - Heartbeat sent after connect + periodic timer
 * - Message queue flushed on reconnect
 * - Reconnect with backoff on disconnect
 * - Command handler invoked on inbound command
 * - disconnect() cleans up timers and connection
 */
import { describe, test, expect, afterEach, beforeEach } from "bun:test";

const TEST_WS_PORT = 19878;
const TEST_TIMEOUT = 15_000;

// ─── Mock WS Server ──────────────────────────────────────────────────

interface MockMessage {
  type: string;
  [key: string]: unknown;
}

let mockServer: ReturnType<typeof Bun.serve> | null = null;
let receivedMessages: MockMessage[] = [];
let serverCloseResolvers: (() => void)[] = [];
let connectedSockets: Set<unknown> = new Set();

function startMockServer(opts?: { rejectAuth?: boolean }) {
  receivedMessages = [];
  connectedSockets = new Set();
  mockServer = Bun.serve({
    port: TEST_WS_PORT,
    fetch(req, server) {
      if (new URL(req.url).pathname === "/ws/device") {
        server.upgrade(req);
        return undefined;
      }
      return new Response("Not found", { status: 404 });
    },
    websocket: {
      open(ws) {
        connectedSockets.add(ws);
      },
      message(ws, data) {
        try {
          const msg = JSON.parse(String(data)) as MockMessage;
          receivedMessages.push(msg);

          // If auth message, optionally reject
          if (msg.type === "auth" && opts?.rejectAuth) {
            ws.close(4003, "auth_failed");
          }
        } catch {}
      },
      close(ws) {
        connectedSockets.delete(ws);
        for (const r of serverCloseResolvers) r();
        serverCloseResolvers = [];
      },
    },
  });
}

function stopMockServer() {
  if (mockServer) {
    mockServer.stop(true);
    mockServer = null;
  }
  connectedSockets = new Set();
  receivedMessages = [];
}

function closeAllServerConnections() {
  for (const ws of connectedSockets) {
    try { (ws as any).close(1000, "test_disconnect"); } catch {}
  }
}

function sendCommandToAll(cmd: object) {
  for (const ws of connectedSockets) {
    try { (ws as any).send(JSON.stringify(cmd)); } catch {}
  }
}

async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs: number,
  intervalMs = 100,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await condition()) return true;
    await Bun.sleep(intervalMs);
  }
  return false;
}

// ─── Tests ────────────────────────────────────────────────────────────

describe("Cloud WS Client", () => {
  // We need a fresh module for each test to reset internal state
  let cloudWs: typeof import("../../src/services/cloud-ws.service");

  beforeEach(async () => {
    startMockServer();
    // Dynamic import to get fresh module state isn't possible with Bun's module cache,
    // so we rely on connect/disconnect to reset state
    cloudWs = await import("../../src/services/cloud-ws.service");
  });

  afterEach(() => {
    try { cloudWs.disconnect(); } catch {}
    stopMockServer();
  });

  test("sends auth message as first message on connect", async () => {
    cloudWs.connect({
      cloudUrl: `http://127.0.0.1:${TEST_WS_PORT}`,
      deviceId: "test-device-001",
      secretKey: "test-secret-key-abc",
      heartbeatFn: () => ({
        type: "heartbeat" as const,
        tunnelUrl: null,
        state: "running",
        appVersion: "0.8.71",
        serverPid: 12345,
        uptime: 60,
        timestamp: new Date().toISOString(),
      }),
    });

    const gotAuth = await waitFor(
      () => receivedMessages.some(m => m.type === "auth"),
      5000,
    );
    expect(gotAuth).toBe(true);

    const authMsg = receivedMessages.find(m => m.type === "auth")!;
    expect(authMsg.deviceId).toBe("test-device-001");
    expect(authMsg.secretKey).toBe("test-secret-key-abc");
    expect(authMsg.timestamp).toBeDefined();
  }, TEST_TIMEOUT);

  test("sends heartbeat immediately after connect", async () => {
    cloudWs.connect({
      cloudUrl: `http://127.0.0.1:${TEST_WS_PORT}`,
      deviceId: "test-device-002",
      secretKey: "secret-002",
      heartbeatFn: () => ({
        type: "heartbeat" as const,
        tunnelUrl: "https://test.trycloudflare.com",
        state: "running",
        appVersion: "0.8.71",
        serverPid: 9999,
        uptime: 120,
        timestamp: new Date().toISOString(),
      }),
    });

    // Wait for both auth + heartbeat
    const gotHeartbeat = await waitFor(
      () => receivedMessages.some(m => m.type === "heartbeat"),
      5000,
    );
    expect(gotHeartbeat).toBe(true);

    const hb = receivedMessages.find(m => m.type === "heartbeat")!;
    expect(hb.state).toBe("running");
    expect(hb.appVersion).toBe("0.8.71");
    expect(hb.tunnelUrl).toBe("https://test.trycloudflare.com");
    expect(hb.serverPid).toBe(9999);
  }, TEST_TIMEOUT);

  test("queues messages when disconnected and flushes on reconnect", async () => {
    cloudWs.connect({
      cloudUrl: `http://127.0.0.1:${TEST_WS_PORT}`,
      deviceId: "test-device-003",
      secretKey: "secret-003",
      heartbeatFn: () => ({
        type: "heartbeat" as const,
        tunnelUrl: null,
        state: "running",
        appVersion: "0.8.71",
        serverPid: null,
        uptime: 0,
        timestamp: new Date().toISOString(),
      }),
    });

    // Wait for connection
    const connected = await waitFor(() => cloudWs.isConnected(), 5000);
    expect(connected).toBe(true);

    // Disconnect from server side
    closeAllServerConnections();
    const disconnected = await waitFor(() => !cloudWs.isConnected(), 3000);
    expect(disconnected).toBe(true);

    // Send a state_change while disconnected — should be queued
    cloudWs.send({
      type: "state_change",
      from: "running",
      to: "paused",
      reason: "max_restarts",
      timestamp: new Date().toISOString(),
    });

    // Wait for auto-reconnect to flush the queue
    const flushed = await waitFor(
      () => receivedMessages.some(m => m.type === "state_change"),
      10_000,
    );
    expect(flushed).toBe(true);

    const stateMsg = receivedMessages.find(m => m.type === "state_change")!;
    expect(stateMsg.from).toBe("running");
    expect(stateMsg.to).toBe("paused");
  }, TEST_TIMEOUT);

  test("isConnected() returns false after disconnect()", async () => {
    cloudWs.connect({
      cloudUrl: `http://127.0.0.1:${TEST_WS_PORT}`,
      deviceId: "test-device-004",
      secretKey: "secret-004",
      heartbeatFn: () => ({
        type: "heartbeat" as const,
        tunnelUrl: null,
        state: "running",
        appVersion: "0.8.71",
        serverPid: null,
        uptime: 0,
        timestamp: new Date().toISOString(),
      }),
    });

    const connected = await waitFor(() => cloudWs.isConnected(), 5000);
    expect(connected).toBe(true);

    cloudWs.disconnect();
    expect(cloudWs.isConnected()).toBe(false);
  }, TEST_TIMEOUT);

  test("invokes command handler on inbound command", async () => {
    let receivedCommand: { action: string; id: string } | null = null;

    cloudWs.connect({
      cloudUrl: `http://127.0.0.1:${TEST_WS_PORT}`,
      deviceId: "test-device-005",
      secretKey: "secret-005",
      heartbeatFn: () => ({
        type: "heartbeat" as const,
        tunnelUrl: null,
        state: "running",
        appVersion: "0.8.71",
        serverPid: null,
        uptime: 0,
        timestamp: new Date().toISOString(),
      }),
    });

    cloudWs.onCommand((cmd) => {
      receivedCommand = { action: cmd.action, id: cmd.id };
    });

    const connected = await waitFor(() => cloudWs.isConnected(), 5000);
    expect(connected).toBe(true);

    // Send a command from server to client
    sendCommandToAll({
      type: "command",
      id: "cmd-123",
      action: "restart",
      timestamp: new Date().toISOString(),
    });

    const gotCommand = await waitFor(() => receivedCommand !== null, 3000);
    expect(gotCommand).toBe(true);
    expect(receivedCommand!.action).toBe("restart");
    expect(receivedCommand!.id).toBe("cmd-123");
  }, TEST_TIMEOUT);

  test("reconnects automatically after server disconnects", async () => {
    cloudWs.connect({
      cloudUrl: `http://127.0.0.1:${TEST_WS_PORT}`,
      deviceId: "test-device-006",
      secretKey: "secret-006",
      heartbeatFn: () => ({
        type: "heartbeat" as const,
        tunnelUrl: null,
        state: "running",
        appVersion: "0.8.71",
        serverPid: null,
        uptime: 0,
        timestamp: new Date().toISOString(),
      }),
    });

    const connected = await waitFor(() => cloudWs.isConnected(), 5000);
    expect(connected).toBe(true);

    // Count auth messages before disconnect
    const authCountBefore = receivedMessages.filter(m => m.type === "auth").length;

    // Disconnect from server side
    closeAllServerConnections();
    await waitFor(() => !cloudWs.isConnected(), 3000);

    // Wait for reconnect (backoff starts at ~1s)
    const reconnected = await waitFor(() => cloudWs.isConnected(), 8000);
    expect(reconnected).toBe(true);

    // Should have sent a new auth message
    const authCountAfter = receivedMessages.filter(m => m.type === "auth").length;
    expect(authCountAfter).toBeGreaterThan(authCountBefore);
  }, TEST_TIMEOUT);
});
