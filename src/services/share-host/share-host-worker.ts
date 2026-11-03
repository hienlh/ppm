/**
 * Share host worker — the process behind the share host's public address.
 *
 * The supervisor re-invokes the binary as `<bin> __share_host__ <port>`. It listens on loopback
 * only (cloudflared, on this machine, is its only client) and answers every request through
 * `share-host-gateway.ts`, which lets the review pages through to PPM and nothing else.
 *
 * Like the edge forwarder it spawns no child, so its listening socket is never inherited and its
 * port is free again the moment it exits — which is what lets the supervisor hand a respawn the
 * same port, keeping the connector that points at it working. `0` asks for any free port, and a
 * preferred port that is taken falls back to one; either way the port it got is written to
 * `.share-host-port` once it listens.
 *
 * It exits when its supervisor does (POSIX: the parent pid changes), so a supervisor that is
 * replaced or killed never leaves a second one behind; on Windows the job object does the same.
 * The parent is read from `/proc/self/stat`, not `process.ppid`: Bun reads that once at start and
 * keeps answering the dead parent's pid after the process is reparented (measured).
 */
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolveTargetPort, _resetTargetCache } from "../edge-target-resolver.ts";
import { createLogger, installFileLogSink } from "../logger.ts";
import { createShareHostHandler } from "./share-host-gateway.ts";
import { SHARE_HOST_PORT_FILE } from "./share-host-config.ts";

const log = createLogger("share-host");

/** Above the gateway's own upstream timeout, so Bun never cuts a slow answer off first. */
const IDLE_TIMEOUT_S = 75;
const PARENT_CHECK_MS = 5000;

export function startShareHostServer(preferredPort: number): ReturnType<typeof Bun.serve> {
  const fetch = createShareHostHandler({ targetPort: () => resolveTargetPort(), resetTargetPort: _resetTargetCache });
  const serve = (port: number) => Bun.serve({ hostname: "127.0.0.1", port, idleTimeout: IDLE_TIMEOUT_S, fetch });
  try {
    return serve(preferredPort);
  } catch (error) {
    if (preferredPort === 0) throw error;
    log.warn(`Port ${preferredPort} is taken (${error}) — listening on a free one instead`);
    return serve(0);
  }
}

/** Whether `parent` is still this process's parent (Linux), or still exists (elsewhere). */
function parentAlive(parent: number): boolean {
  try {
    const stat = readFileSync("/proc/self/stat", "utf8");
    return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]) === parent;
  } catch {}
  try {
    process.kill(parent, 0);
    return true;
  } catch (e) {
    return (e as { code?: string }).code !== "ESRCH";
  }
}

function publishPort(port: number): void {
  const file = SHARE_HOST_PORT_FILE();
  const tmp = `${file}.tmp.${process.pid}`;
  writeFileSync(tmp, String(port));
  renameSync(tmp, file);
}

// ─── Process entry ─────────────────────────────────────────────────────
if (process.argv.includes("__share_host__")) {
  // Lines go to ppm.log like every other process's; the supervisor hands the log over as stderr.
  installFileLogSink({ echo: "stderr" });
  const idx = process.argv.indexOf("__share_host__");
  const preferred = parseInt(process.argv[idx + 1] ?? "0", 10);
  if (!Number.isInteger(preferred) || preferred < 0 || preferred > 65535) {
    log.fatal(`Invalid port: ${process.argv[idx + 1]} — exiting`);
    process.exit(2);
  }

  try {
    const server = startShareHostServer(preferred);
    publishPort(server.port!);
    log.info(`Listening on 127.0.0.1:${server.port}`);
  } catch (error) {
    log.fatal(`Failed to listen: ${error} — exiting`);
    process.exit(1);
  }

  if (process.platform !== "win32") {
    const parent = process.ppid;
    setInterval(() => {
      if (parentAlive(parent)) return;
      log.info("Supervisor is gone — exiting");
      process.exit(0);
    }, PARENT_CHECK_MS);
  }
}
