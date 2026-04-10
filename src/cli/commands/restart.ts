import { resolve } from "node:path";
import { readFileSync, writeFileSync, existsSync, openSync, unlinkSync, renameSync } from "node:fs";
import { getPpmDir } from "../../services/ppm-dir.ts";

const statusFile = () => resolve(getPpmDir(), "status.json");
const pidFile = () => resolve(getPpmDir(), "ppm.pid");
const restartingFlag = () => resolve(getPpmDir(), ".restarting");
const restartResult = () => resolve(getPpmDir(), ".restart-result");

/** Restart only the server process, keeping the tunnel alive */
export async function restartServer(options: { config?: string; force?: boolean }) {
  // Ignore SIGHUP so this process survives when PPM terminal dies
  process.on("SIGHUP", () => {});

  if (!existsSync(statusFile())) {
    console.log("No PPM daemon running. Use 'ppm start' instead.");
    process.exit(1);
  }

  let status: Record<string, unknown>;
  try {
    status = JSON.parse(readFileSync(statusFile(), "utf-8"));
  } catch {
    console.log("Corrupt status file. Use 'ppm stop && ppm start' instead.");
    process.exit(1);
  }

  // Supervisor-aware restart: send SIGUSR2 → supervisor restarts server child
  const supervisorPid = status.supervisorPid as number | undefined;
  if (supervisorPid) {
    try { process.kill(supervisorPid, 0); } catch {
      console.log("Supervisor not running. Use 'ppm stop && ppm start' instead.");
      process.exit(1);
    }

    // Check if supervisor is paused — require --force to resume
    const state = status.state as string | undefined;
    if (state === "paused" && !options.force) {
      console.log("\n  Server is paused (crashed too many times).");
      console.log("  Use 'ppm restart --force' to resume.\n");
      process.exit(1);
    }

    // Stopped state: treat restart as resume (send resume command)
    if (state === "stopped") {
      console.log("\n  Server is stopped. Resuming via supervisor...\n");
      const cmdFile = resolve(getPpmDir(), ".supervisor-cmd");
      writeFileSync(cmdFile, JSON.stringify({ action: "resume" }));
      // Signal supervisor (Windows: polling picks up command file)
      if (process.platform !== "win32") {
        try { process.kill(supervisorPid, "SIGUSR2"); } catch (e) {
          console.error(`  ✗  Failed to signal supervisor: ${e}`);
          process.exit(1);
        }
      }
      // Wait for state to change back to running
      const rStart = Date.now();
      while (Date.now() - rStart < 15_000) {
        await Bun.sleep(500);
        try {
          const newStatus = JSON.parse(readFileSync(statusFile(), "utf-8"));
          if (newStatus.state === "running" && newStatus.pid) {
            console.log(`  ✓  Server resumed (PID: ${newStatus.pid})`);
            if (newStatus.shareUrl) console.log(`  ➜  Share:   ${newStatus.shareUrl}`);
            process.exit(0);
          }
        } catch {}
      }
      console.error("  ⚠  Resume timed out. Check: ppm logs");
      process.exit(1);
    }

    const oldServerPid = status.pid as number | undefined;
    console.log("\n  Restarting PPM server via supervisor...");
    console.log("  If you're using PPM terminal, wait a few seconds for auto-reconnect.\n");

    try { process.kill(supervisorPid, "SIGUSR2"); } catch (e) {
      console.error(`  ✗  Failed to signal supervisor: ${e}`);
      process.exit(1);
    }

    // Wait for new server PID to appear in status.json (up to 15s)
    const start = Date.now();
    while (Date.now() - start < 15_000) {
      await Bun.sleep(500);
      try {
        const newStatus = JSON.parse(readFileSync(statusFile(), "utf-8"));
        const newPid = newStatus.pid as number | undefined;
        if (newPid && newPid !== oldServerPid) {
          // Verify it's alive
          try { process.kill(newPid, 0); } catch { continue; }
          console.log(`  ✓  Restart complete (new PID: ${newPid})`);
          if (newStatus.shareUrl) console.log(`  ➜  Share:   ${newStatus.shareUrl}`);
          process.exit(0);
        }
      } catch {}
    }

    console.error("  ⚠  Restart timed out. Check: ppm logs");
    process.exit(1);
  }

  // Legacy path: no supervisor (pre-supervisor daemon)
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
  writeFileSync(restartingFlag(), "");

  // Clear previous result
  try { unlinkSync(restartResult()); } catch {}

  // Pre-restart message — user sees this before terminal dies (if running inside PPM)
  console.log("\n  Restarting PPM server...");
  console.log("  If you're using PPM terminal, wait a few seconds for auto-reconnect.\n");

  // Generate a self-contained restart worker script.
  // Worker ignores SIGHUP so it survives when killing the server causes the
  // terminal (and its process group) to receive SIGHUP.
  const params = JSON.stringify({
    serverPid, port, host, serverScript,
    config: options.config ?? "",
    statusFile: statusFile(),
    pidFile: pidFile(),
    restartingFlag: restartingFlag(),
    resultFile: restartResult(),
    ppmDir: getPpmDir(),
  });

  const workerPath = resolve(getPpmDir(), ".restart-worker.ts");
  writeFileSync(workerPath, `
import { readFileSync, writeFileSync, openSync, unlinkSync, appendFileSync } from "node:fs";
import { createServer } from "node:net";
import { spawnSync } from "node:child_process";

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

  // Kill old server PID
  try { process.kill(P.serverPid); log("INFO", "Restart: killed old server PID " + P.serverPid); } catch {}
  await Bun.sleep(500);

  // Force-kill any process still holding the port (handles orphan/zombie processes)
  const killByPort = () => {
    try {
      if (process.platform === "win32") {
        const r = Bun.spawnSync(["cmd", "/c", "netstat -ano | findstr :" + P.port + " | findstr LISTENING"]);
        const lines = r.stdout.toString().trim().split("\\n");
        const pids = new Set(lines.map((l: string) => l.trim().split(/\\s+/).pop()).filter(Boolean));
        for (const pid of pids) { try { process.kill(Number(pid)); } catch {} }
      } else {
        const r = Bun.spawnSync(["lsof", "-t", "-i", ":" + P.port]);
        const pids = r.stdout.toString().trim().split("\\n").filter(Boolean);
        for (const pid of pids) { try { process.kill(Number(pid)); } catch {} }
      }
    } catch {}
  };
  killByPort();

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
    killByPort();
    await Bun.sleep(200);
  }

  // Spawn new server — on Windows use PowerShell Start-Process for true detach
  // (Bun.spawn + unref on Windows keeps child in same job object → dies when worker exits)
  let childPid: number;
  // Compiled binary: execPath IS the server, no "run script" needed
  const isCompiled = !process.execPath.includes("bun");
  const serverArgs = isCompiled
    ? ["__serve__", String(P.port), P.host, P.config].filter(Boolean)
    : ["run", P.serverScript, "__serve__", String(P.port), P.host, P.config].filter(Boolean);

  if (process.platform === "win32") {
    const bunExe = process.execPath.replace(/\\\\/g, "\\\\\\\\");
    const logPath = (P.ppmDir + "/ppm.log").replace(/\\//g, "\\\\").replace(/\\\\/g, "\\\\\\\\");
    const errPath = (P.ppmDir + "/ppm.err.log").replace(/\\//g, "\\\\").replace(/\\\\/g, "\\\\\\\\");
    const argStr = serverArgs.map((a: string) => "'" + (a || "_") + "'").join(",");
    const psCmd = "$p = Start-Process -PassThru -WindowStyle Hidden"
      + " -FilePath '" + bunExe + "'"
      + " -ArgumentList " + argStr
      + " -RedirectStandardOutput '" + logPath + "'"
      + " -RedirectStandardError '" + errPath + "'"
      + "; Write-Output $p.Id";
    const r = spawnSync("powershell", ["-NoProfile", "-Command", psCmd], { stdio: ["ignore", "pipe", "pipe"] });
    childPid = parseInt(String(r.stdout).trim(), 10);
    if (isNaN(childPid)) {
      log("ERROR", "Failed to start server via PowerShell: " + String(r.stderr).trim());
      writeResult(false, "Failed to start server on Windows");
      process.exit(1);
    }
  } else {
    const logFd = openSync(P.ppmDir + "/ppm.log", "a");
    const child = Bun.spawn({
      cmd: [process.execPath, ...serverArgs],
      stdio: ["ignore", logFd, logFd],
      env: process.env,
    });
    child.unref();
    childPid = child.pid;
  }

  // Update status.json with new PID, keep tunnel info (atomic write to avoid cross-process races)
  try {
    const status = JSON.parse(readFileSync(P.statusFile, "utf-8"));
    status.pid = childPid;
    status.serverScript = P.serverScript;
    const tmp = P.statusFile + ".tmp." + process.pid;
    writeFileSync(tmp, JSON.stringify(status));
    renameSync(tmp, P.statusFile);
    writeFileSync(P.pidFile, String(childPid));
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
    let msg = "Restart complete (PID: " + childPid + ", port: " + P.port + ")";
    if (shareUrl && tunnelPid) {
      msg += tunnelAlive ? " — tunnel alive" : " — tunnel dead, run 'ppm stop && ppm start --share'";
    }
    log("INFO", msg);
    writeResult(true, msg);
  } else {
    let alive = false;
    try { process.kill(childPid, 0); alive = true; } catch {}
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
  const logFile = resolve(getPpmDir(), "ppm.log");
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
    if (existsSync(restartResult())) {
      try {
        const result = JSON.parse(readFileSync(restartResult(), "utf-8"));
        if (result.ok) {
          console.log(`  ✓  ${result.message}`);
        } else {
          console.error(`  ✗  ${result.message}`);
        }
        unlinkSync(restartResult());
      } catch {}
      process.exit(0);
    }
  }

  // Timeout — worker might still be running
  console.error("  ⚠  Restart timed out. Check: ppm logs");
  process.exit(1);
}
