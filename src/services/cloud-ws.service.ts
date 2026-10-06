/**
 * Cloud WebSocket client — persistent connection from supervisor to PPM Cloud.
 * Auto-reconnects with exponential backoff + jitter. Queues messages when disconnected.
 */
import { createLogger, type LogLevel } from "./logger.ts";

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
  deviceName?: string;
}

interface StateChangeMsg extends WsMessage {
  type: "state_change";
  from: string;
  to: string;
  reason: string;
}

interface CommandAckMsg extends WsMessage {
  type: "command_ack";
  id: string;
}

interface CommandResultMsg extends WsMessage {
  type: "command_result";
  id: string;
  success: boolean;
  error?: string;
  data?: Record<string, unknown>;
}

interface NotificationMsg extends WsMessage {
  type: "notification";
  title: string;
  body: string;
  project: string;
  sessionId: string;
  sessionTitle?: string;
  notificationType: "done" | "approval_request" | "question";
}

type OutboundMsg = HeartbeatMsg | StateChangeMsg | CommandAckMsg | CommandResultMsg | NotificationMsg;

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

// While Cloud is unreachable every attempt fails the same way, about six a minute: the
// first failure is a warning, the retries are debug, and getting back is one info line.
let outageReported = false;
let offlineSince = 0;
let attemptsWhileOffline = 0;
let lastConstructError: string | null = null;

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
  reconnecting = false; // prevent stale flag from blocking future doConnect()
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

/** Returns true if WS is authenticated and ready, or still in auth handshake */
export function isConnected(): boolean {
  // Also treat "connecting/open but auth pending" as connected to prevent
  // external monitors from killing a valid WS during the 500ms auth delay.
  if (connected) return true;
  return ws !== null && ws.readyState <= WebSocket.OPEN;
}

/** Send a push notification via Cloud WS (Cloud dispatches Web Push to subscribed browsers) */
export function sendNotification(payload: {
  title: string;
  body: string;
  project: string;
  sessionId: string;
  sessionTitle?: string;
  notificationType: "done" | "approval_request" | "question";
}): void {
  const msg: NotificationMsg = {
    type: "notification",
    ...payload,
    timestamp: new Date().toISOString(),
  };
  send(msg);
}

// ─── Internal ───────────────────────────────────────

function doConnect(): void {
  if (!shouldConnect || reconnecting) return;
  reconnecting = true;
  if (outageReported) attemptsWhileOffline++;

  // Capture local ref — if a reconnect replaces `ws` before this socket's
  // handlers fire, stale handlers must not reset module-level state.
  let sock: WebSocket;
  try {
    sock = new WebSocket(wsUrl);
    ws = sock;
  } catch (e) {
    reconnecting = false;
    markOffline();
    // A bad cloud_url fails here on every attempt, forever: say why once, not per retry.
    const reason = e instanceof Error ? e.message : String(e);
    log(reason === lastConstructError ? "DEBUG" : "WARN", `Cloud WS cannot connect to ${cloudHost()}: ${reason}`);
    lastConstructError = reason;
    scheduleReconnect("constructor");
    return;
  }

  sock.onopen = () => {
    if (ws !== sock) return; // stale — newer connection replaced us
    reconnecting = false;
    // Don't reset reconnectAttempt here — only after auth succeeds.
    // Resetting on open causes tight reconnect loops when the server
    // keeps closing immediately after connect (backoff never builds up).
    log("DEBUG", "Cloud WS connected, sending auth");

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
      reconnectAttempt = 0; // Auth succeeded — reset backoff
      if (outageReported) {
        log("INFO", `Cloud WS connected (after ${attemptsWhileOffline} attempts, ${Math.round((Date.now() - offlineSince) / 1000)}s offline)`);
      } else {
        log("INFO", "Cloud WS connected");
      }
      outageReported = false;
      attemptsWhileOffline = 0;
      lastConstructError = null;

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
    log(markOffline() ? "WARN" : "DEBUG", `Cloud WS closed: code=${event.code} reason=${event.reason || ""}`);
    connected = false;
    reconnecting = false;
    ws = null;
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    // 4010 = server replaced this connection (another is already active) or reconnecting
    // too fast — do NOT reconnect to avoid feedback loop
    if (event.code === 4010) {
      log("INFO", "Cloud WS closed with 4010 (replaced/throttled), not reconnecting");
      return;
    }
    if (shouldConnect) scheduleReconnect("onclose");
  };

  // Always followed by onclose, which carries the code and reason.
  sock.onerror = (event) => {
    log("DEBUG", `Cloud WS error: ${(event as ErrorEvent).message || event.type}`);
  };
}

function scheduleReconnect(source = "unknown"): void {
  if (!shouldConnect || reconnectTimer) return;
  const base = BACKOFF_STEPS[Math.min(reconnectAttempt, BACKOFF_STEPS.length - 1)]!;
  // Add ±30% jitter to prevent thundering herd after Cloud deploy
  const jitter = base * (0.7 + Math.random() * 0.6);
  const delay = Math.round(jitter);
  reconnectAttempt++;
  log("DEBUG", `Cloud WS reconnect in ${delay}ms (attempt #${reconnectAttempt}) src=${source}`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    doConnect();
  }, delay);
}

/** Returns true when this failure starts an outage (the one worth a warning). */
function markOffline(): boolean {
  if (outageReported) return false;
  outageReported = true;
  offlineSince = Date.now();
  attemptsWhileOffline = 0;
  return true;
}

/** Host of the Cloud endpoint, for a log line: never the path, never credentials in the URL. */
function cloudHost(): string {
  return wsUrl.replace(/^[a-z]+:\/\//i, "").split("/")[0]!.split("@").pop()!;
}

const cloudLog = createLogger("cloud-ws");

function log(level: "DEBUG" | "INFO" | "WARN" | "ERROR", msg: string): void {
  cloudLog[level.toLowerCase() as LogLevel](msg);
}
