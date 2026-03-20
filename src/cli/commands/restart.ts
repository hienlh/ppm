import { resolve } from "node:path";
import { homedir } from "node:os";
import { readFileSync, writeFileSync, existsSync, openSync, unlinkSync } from "node:fs";

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

  // Write restarting flag so tunnel cleanup handler skips killing cloudflared
  writeFileSync(RESTARTING_FLAG, "");

  // Kill old server process
  try {
    process.kill(serverPid);
    console.log(`  Stopped server (PID: ${serverPid})`);
  } catch {
    console.log(`  Server already stopped (PID: ${serverPid})`);
  }

  // Brief pause for port release
  await Bun.sleep(500);

  // Set DB profile before loading config
  const { setDbProfile } = await import("../../services/db.service.ts");
  if (options.config && /dev/i.test(options.config)) {
    setDbProfile("dev");
  }

  // Reload config for new server
  const { configService } = await import("../../services/config.service.ts");
  configService.load(options.config);
  const port = status.port as number ?? configService.get("port");
  const host = status.host as string ?? configService.get("host");

  // Spawn new server child process
  const ppmDir = resolve(homedir(), ".ppm");
  const logFile = resolve(ppmDir, "ppm.log");
  const logFd = openSync(logFile, "a");
  const child = Bun.spawn({
    cmd: [
      process.execPath, "run",
      resolve(import.meta.dir, "../../server/index.ts"), "__serve__",
      String(port), host, options.config ?? "",
    ],
    stdio: ["ignore", logFd, logFd],
    env: process.env,
  });
  child.unref();

  // Update status with new server PID, keep tunnel info
  status.pid = child.pid;
  writeFileSync(STATUS_FILE, JSON.stringify(status));
  writeFileSync(PID_FILE, String(child.pid));

  // Remove restarting flag
  try { unlinkSync(RESTARTING_FLAG); } catch {}

  const { VERSION } = await import("../../version.ts");
  console.log(`\n  PPM v${VERSION} restarted (PID: ${child.pid})\n`);
  console.log(`  ➜  Local:   http://localhost:${port}/`);
  if (status.shareUrl) {
    console.log(`  ➜  Share:   ${status.shareUrl}  (tunnel kept alive)`);
  }
  console.log();

  process.exit(0);
}
