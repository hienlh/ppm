/**
 * Cloud WebSocket client — persistent connection from supervisor to PPM Cloud.
 * Auto-reconnects with exponential backoff + jitter. Queues messages when disconnected.
 */
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

// ─── Types (must match Cloud's ws-types.ts) ─────────
interface WsMessage {
  type: string;
  id?: string;
  timestamp: string;
}

interface HeartbeatMsg extends WsMessage {
  type: "heartbeat";
  tunnelUrl: string | null;
  state: string;
  appVersion: string;
  availableVersion: string | null;
  serverPid: number | null;
  uptime: number;
}

interface StateChangeMsg extends WsMessage {
  type: "state_change";
  from: string;
  to: string;
  reason: string;
}

interface CommandResultMsg extends WsMessage {
  type: "command_result";
  id: string;
  success: boolean;
  error?: string;
  data?: Record<string, unknown>;
}

type OutboundMsg = HeartbeatMsg | StateChangeMsg | CommandResultMsg;

interface CommandMsg extends WsMessage {
  type: "command";
  id: string;
  action: string;
  params?: Record<string, unknown>;
}

type CommandHandler = (cmd: CommandMsg) => void;

// ─── Constants ──────────────────────────────────────
const BACKOFF_STEPS = [1000, 2000, 4000, 8000, 15000, 30000, 60000];
const MAX_QUEUE_SIZE = 50;
const HEARTBEAT_INTERVAL_MS = 60_000; // 60s via WS

// ─── State ──────────────────────────────────────────
let ws: WebSocket | null = null;
let connected = false;
let reconnecting = false;
let reconnectAttempt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let commandHandler: CommandHandler | null = null;
let outboundQueue: OutboundMsg[] = [];
let wsUrl = "";
let shouldConnect = false;

// Credentials for first-message auth
let deviceId = "";
let secretKey = "";

// For heartbeat payload
let getHeartbeatData: (() => HeartbeatMsg) | null = null;

// ─── Public API ─────────────────────────────────────

export function connect(opts: {
  cloudUrl: string;
  deviceId: string;
  secretKey: string;
  heartbeatFn: () => HeartbeatMsg;
}): void {
  // No secret_key in URL — auth via first message after connect
  wsUrl = `${opts.cloudUrl.replace(/^http/, "ws")}/ws/device`;
  deviceId = opts.deviceId;
  secretKey = opts.secretKey;
  getHeartbeatData = opts.heartbeatFn;
  shouldConnect = true;
  reconnectAttempt = 0;
  doConnect();
}

export function disconnect(): void {
  shouldConnect = false;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  if (ws) {
    try { ws.close(1000, "shutdown"); } catch {}
    ws = null;
  }
  connected = false;
  outboundQueue = [];
}

export function send(msg: OutboundMsg): void {
  if (connected && ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  } else {
    outboundQueue.push(msg);
    if (outboundQueue.length > MAX_QUEUE_SIZE) outboundQueue.shift();
  }
}

export function onCommand(handler: CommandHandler): void {
  commandHandler = handler;
}

export function isConnected(): boolean {
  return connected;
}

// ─── Internal ───────────────────────────────────────

function doConnect(): void {
  if (!shouldConnect || reconnecting) return;
  reconnecting = true;

  // Capture local ref — if a reconnect replaces `ws` before this socket's
  // handlers fire, stale handlers must not reset module-level state.
  let sock: WebSocket;
  try {
    sock = new WebSocket(wsUrl);
    ws = sock;
  } catch {
    reconnecting = false;
    scheduleReconnect("constructor");
    return;
  }

  sock.onopen = () => {
    if (ws !== sock) return; // stale — newer connection replaced us
    reconnecting = false;
    reconnectAttempt = 0;
    log("INFO", "Cloud WS connected, sending auth");

    // Send auth as first message — server must process this before any other msg
    sock.send(JSON.stringify({
      type: "auth",
      deviceId,
      secretKey,
      timestamp: new Date().toISOString(),
      version: 1,
    }));

    // Delay setting connected + sending heartbeat to let server process auth.
    // Server's authenticateDevice() is async (DB lookup), so messages sent
    // immediately after auth arrive before authenticated=true → 4002 reject.
    setTimeout(() => {
      if (ws !== sock) return; // replaced during delay
      connected = true;

      // Flush queued messages
      while (outboundQueue.length > 0 && connected) {
        const msg = outboundQueue.shift()!;
        sock.send(JSON.stringify(msg));
      }

      // Send immediate heartbeat
      if (getHeartbeatData) send(getHeartbeatData());

      // Start periodic heartbeat
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = setInterval(() => {
        if (getHeartbeatData && connected) send(getHeartbeatData());
      }, HEARTBEAT_INTERVAL_MS);
    }, 500); // 500ms for DB auth round-trip
  };

  sock.onmessage = (event) => {
    try {
      const msg = JSON.parse(String(event.data)) as CommandMsg;
      if (msg.type === "command" && commandHandler) {
        commandHandler(msg);
      }
    } catch {} // ignore malformed
  };

  sock.onclose = (event) => {
    if (ws !== sock) return; // stale — ignore close from replaced connection
    log("WARN", `Cloud WS closed: code=${event.code} reason=${event.reason || ""}`);
    connected = false;
    reconnecting = false;
    ws = null;
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    if (shouldConnect) scheduleReconnect("onclose");
  };

  sock.onerror = (event) => {
    log("ERROR", `Cloud WS error: ${String(event)}`);
  };
}

function scheduleReconnect(source = "unknown"): void {
  if (!shouldConnect || reconnectTimer) return;
  const base = BACKOFF_STEPS[Math.min(reconnectAttempt, BACKOFF_STEPS.length - 1)]!;
  // Add ±30% jitter to prevent thundering herd after Cloud deploy
  const jitter = base * (0.7 + Math.random() * 0.6);
  const delay = Math.round(jitter);
  reconnectAttempt++;
  log("WARN", `Cloud WS reconnect in ${delay}ms (attempt #${reconnectAttempt}) src=${source}`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    doConnect();
  }, delay);
}

function log(level: string, msg: string): void {
  const ts = new Date().toISOString();
  const logFile = resolve(process.env.PPM_HOME || resolve(homedir(), ".ppm"), "ppm.log");
  try { appendFileSync(logFile, `[${ts}] [${level}] [cloud-ws] ${msg}\n`); } catch {}
}
