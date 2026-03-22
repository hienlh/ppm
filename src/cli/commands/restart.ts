import { resolve } from "node:path";
import { homedir } from "node:os";
import { readFileSync, writeFileSync, existsSync, openSync, unlinkSync } from "node:fs";

const PPM_DIR = resolve(homedir(), ".ppm");
const STATUS_FILE = resolve(PPM_DIR, "status.json");
const PID_FILE = resolve(PPM_DIR, "ppm.pid");
const RESTARTING_FLAG = resolve(PPM_DIR, ".restarting");
const RESTART_RESULT = resolve(PPM_DIR, ".restart-result");

/** Restart only the server process, keeping the tunnel alive */
export async function restartServer(options: { config?: string }) {
  // Ignore SIGHUP so this process survives when PPM terminal dies
  process.on("SIGHUP", () => {});

  if (!existsSync(STATUS_FILE)) {
    console.log("No PPM daemon running. Use 'ppm start' instead.");
    process.exit(1);
  }

  let status: Record<string, unknown>;
  try {
    status = JSON.parse(readFileSync(STATUS_FILE, "utf-8"));
  } catch {
    console.log("Corrupt status file. Use 'ppm stop && ppm start' instead.");
    process.exit(1);
  }

  const serverPid = status.pid as number | undefined;
  if (!serverPid) {
    console.log("No server PID found. Use 'ppm stop && ppm start' instead.");
    process.exit(1);
  }

  // Resolve server script: prefer saved path (stable install), fall back to import.meta.dir
  const savedScript = status.serverScript as string | undefined;
  const serverScript = savedScript && existsSync(savedScript)
    ? savedScript
    : resolve(import.meta.dir, "../../server/index.ts");

  const { configService } = await import("../../services/config.service.ts");
  configService.load(options.config);
  const port = status.port as number ?? configService.get("port");
  const host = status.host as string ?? configService.get("host");

  // Write restarting flag so tunnel cleanup handler skips killing cloudflared
  writeFileSync(RESTARTING_FLAG, "");

  // Clear previous result
  try { unlinkSync(RESTART_RESULT); } catch {}

  // Pre-restart message — user sees this before terminal dies (if running inside PPM)
  console.log("\n  Restarting PPM server...");
  console.log("  If you're using PPM terminal, wait a few seconds for auto-reconnect.\n");

  // Generate a self-contained restart worker script.
  // Worker ignores SIGHUP so it survives when killing the server causes the
  // terminal (and its process group) to receive SIGHUP.
  const params = JSON.stringify({
    serverPid, port, host, serverScript,
    config: options.config ?? "",
    statusFile: STATUS_FILE,
    pidFile: PID_FILE,
    restartingFlag: RESTARTING_FLAG,
    resultFile: RESTART_RESULT,
    ppmDir: PPM_DIR,
  });

  const workerPath = resolve(PPM_DIR, ".restart-worker.ts");
  writeFileSync(workerPath, `
import { readFileSync, writeFileSync, openSync, unlinkSync, appendFileSync } from "node:fs";
import { createServer } from "node:net";

// Ignore SIGHUP — when we kill the old server, the terminal PTY dies and
// SIGHUP is sent to the entire process group. Without this, the worker
// would be killed before it can spawn the new server.
process.on("SIGHUP", () => {});

const P = ${params};

async function main() {
  const log = (level: string, msg: string) => {
    const ts = new Date().toISOString();
    try { appendFileSync(P.ppmDir + "/ppm.log", "[" + ts + "] [" + level + "] " + msg + "\\n"); } catch {}
  };
  const writeResult = (ok: boolean, msg: string) => {
    try { writeFileSync(P.resultFile, JSON.stringify({ ok, message: msg })); } catch {}
  };

  // Kill old server
  try { process.kill(P.serverPid); log("INFO", "Restart: killed old server PID " + P.serverPid); } catch {}

  // Wait for port to be free (up to 5s)
  const start = Date.now();
  while (Date.now() - start < 5000) {
    const inUse: boolean = await new Promise((res) => {
      const t = createServer()
        .once("error", () => res(true))
        .once("listening", () => { t.close(() => res(false)); })
        .listen(P.port, P.host);
    });
    if (!inUse) break;
    await Bun.sleep(200);
  }

  // Spawn new server
  const logFd = openSync(P.ppmDir + "/ppm.log", "a");
  const child = Bun.spawn({
    cmd: [process.execPath, "run", P.serverScript, "__serve__", String(P.port), P.host, P.config],
    stdio: ["ignore", logFd, logFd],
    env: process.env,
  });
  child.unref();

  // Update status.json with new PID, keep tunnel info
  try {
    const status = JSON.parse(readFileSync(P.statusFile, "utf-8"));
    status.pid = child.pid;
    status.serverScript = P.serverScript;
    writeFileSync(P.statusFile, JSON.stringify(status));
    writeFileSync(P.pidFile, String(child.pid));
  } catch {}

  // Remove restarting flag
  try { unlinkSync(P.restartingFlag); } catch {}

  // Health check (up to 10s)
  let ready = false;
  const hStart = Date.now();
  while (Date.now() - hStart < 10000) {
    try {
      const res = await fetch("http://127.0.0.1:" + P.port + "/api/health", { signal: AbortSignal.timeout(1000) });
      if (res.ok) { ready = true; break; }
    } catch {}
    await Bun.sleep(300);
  }

  // Check tunnel
  let tunnelAlive = false;
  let tunnelPid: number | undefined;
  let shareUrl: string | undefined;
  try {
    const st = JSON.parse(readFileSync(P.statusFile, "utf-8"));
    tunnelPid = st.tunnelPid;
    shareUrl = st.shareUrl;
    if (tunnelPid) { process.kill(tunnelPid, 0); tunnelAlive = true; }
  } catch {}

  if (ready) {
    let msg = "Restart complete (PID: " + child.pid + ", port: " + P.port + ")";
    if (shareUrl && tunnelPid) {
      msg += tunnelAlive ? " — tunnel alive" : " — tunnel dead, run 'ppm stop && ppm start --share'";
    }
    log("INFO", msg);
    writeResult(true, msg);
  } else {
    let alive = false;
    try { process.kill(child.pid, 0); alive = true; } catch {}
    const msg = alive
      ? "Server started but not responding on port " + P.port + ". Check: ppm logs"
      : "Server crashed on startup. Check: ppm logs";
    log("ERROR", msg);
    writeResult(false, msg);
  }

  // Cleanup worker file
  try { unlinkSync(P.ppmDir + "/.restart-worker.ts"); } catch {}
  process.exit(0);
}

main();
`);

  // Spawn worker as a fully detached process
  const logFile = resolve(PPM_DIR, "ppm.log");
  const logFd = openSync(logFile, "a");
  const worker = Bun.spawn({
    cmd: [process.execPath, "run", workerPath],
    stdio: ["ignore", logFd, logFd],
    env: process.env,
  });
  worker.unref();

  // Poll for result — works from both PPM terminal (SIGHUP-immune) and external terminal.
  // Output may not be visible if PPM terminal PTY is dead, but process stays alive.
  const pollStart = Date.now();
  while (Date.now() - pollStart < 20000) {
    await Bun.sleep(500);
    if (existsSync(RESTART_RESULT)) {
      try {
        const result = JSON.parse(readFileSync(RESTART_RESULT, "utf-8"));
        if (result.ok) {
          console.log(`  ✓  ${result.message}`);
        } else {
          console.error(`  ✗  ${result.message}`);
        }
        unlinkSync(RESTART_RESULT);
      } catch {}
      process.exit(0);
    }
  }

  // Timeout — worker might still be running
  console.error("  ⚠  Restart timed out. Check: ppm logs");
  process.exit(1);
}
