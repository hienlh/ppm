import { resolve } from "node:path";
import { homedir } from "node:os";
import { readFileSync, writeFileSync, existsSync, openSync } from "node:fs";

const PPM_DIR = resolve(homedir(), ".ppm");
const STATUS_FILE = resolve(PPM_DIR, "status.json");
const PID_FILE = resolve(PPM_DIR, "ppm.pid");
const RESTARTING_FLAG = resolve(PPM_DIR, ".restarting");

/** Restart only the server process, keeping the tunnel alive */
export async function restartServer(options: { config?: string }) {
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

  // Generate a self-contained restart worker script.
  // This runs as a detached process so it survives even if the current process
  // (and the PPM server hosting its terminal) is killed.
  const params = JSON.stringify({
    serverPid, port, host, serverScript,
    config: options.config ?? "",
    statusFile: STATUS_FILE,
    pidFile: PID_FILE,
    restartingFlag: RESTARTING_FLAG,
    ppmDir: PPM_DIR,
  });

  const workerPath = resolve(PPM_DIR, ".restart-worker.ts");
  writeFileSync(workerPath, `
import { readFileSync, writeFileSync, openSync, unlinkSync, appendFileSync, existsSync } from "node:fs";
import { createServer } from "node:net";

const P = ${params};

async function main() {
  const log = (level: string, msg: string) => {
    const ts = new Date().toISOString();
    try { appendFileSync(P.ppmDir + "/ppm.log", "[" + ts + "] [" + level + "] " + msg + "\\n"); } catch {}
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

  if (ready) {
    log("INFO", "Restart complete — new server PID " + child.pid);
  } else {
    let alive = false;
    try { process.kill(child.pid, 0); alive = true; } catch {}
    log("ERROR", "Restart failed — server " + (alive ? "not responding on port " + P.port : "crashed on startup"));
  }

  // Cleanup worker file
  try { unlinkSync(P.ppmDir + "/.restart-worker.ts"); } catch {}
  process.exit(0);
}

main();
`);

  // Spawn worker as a fully detached process
  const logFd = openSync(resolve(PPM_DIR, "ppm.log"), "a");
  const worker = Bun.spawn({
    cmd: [process.execPath, "run", workerPath],
    stdio: ["ignore", logFd, logFd],
    env: process.env,
  });
  worker.unref();

  const { VERSION } = await import("../../version.ts");
  console.log(`\n  PPM v${VERSION} restarting... (worker PID: ${worker.pid})`);
  console.log(`  Server will restart in background. Check: ppm status\n`);

  process.exit(0);
}
