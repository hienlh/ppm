/**
 * One MediaMTX relay per Remote Desktop session: pick free ports, write the generated config,
 * spawn the binary, and wait until it is genuinely listening before anything tries to use it.
 *
 * "Genuinely listening" is not decorative. MediaMTX exits with a plain `ERR listen tcp ...
 * address already in use` when a port is taken, and at the `warn` log level PPM asks for, a
 * successful start prints *nothing at all* — so there is no output to wait for, and a caller
 * that assumed the spawn meant readiness would push RTSP at a socket that is not there yet.
 * `waitUntilListening` connects to the loopback signalling port instead.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { buildMediamtxConfig, randomStreamPath, rtspPublishUrl, whepUrl } from "./mediamtx-config.ts";
import { findMediamtxBinary, mediamtxConfigPath } from "./mediamtx-paths.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("remote-desktop");

export interface RelayHandle {
  /** Where ffmpeg pushes the H.264 it already encoded. */
  publishUrl: string;
  /** Loopback WHEP endpoint. Only PPM's authenticated proxy ever calls this. */
  whepUrl: string;
  /** This session's unguessable stream path. */
  pathName: string;
  stop(): void;
  isStopped(): boolean;
}

const active = new Set<RelayHandle>();
let sweepRegistered = false;

/** Kill every relay on the way out, the way `registerRemoteDesktopExitSweep` does for sessions. */
export function registerRelayExitSweep(): void {
  if (sweepRegistered) return;
  sweepRegistered = true;
  const sweep = () => { for (const r of [...active]) r.stop(); };
  process.on("exit", sweep);
  process.on("SIGINT", sweep);
  process.on("SIGTERM", sweep);
}

/**
 * A free TCP port, found by binding one and letting the OS choose.
 *
 * Inherently racy — the port is free when asked and could be taken before MediaMTX binds it —
 * which is why `startRelay` surfaces a bind failure as an error rather than retrying blind.
 */
async function freeTcpPort(): Promise<number> {
  const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = server.port;
  server.stop(true);
  return port;
}

/** Same, for the ICE port. UDP has to be asked separately: a free TCP port says nothing. */
async function freeUdpPort(): Promise<number> {
  const sock = await Bun.udpSocket({ port: 0 });
  const port = sock.port;
  sock.close();
  return port;
}

/** Poll a loopback TCP port until something accepts, or give up. */
async function waitUntilListening(port: number, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const sock = await Bun.connect({ hostname: "127.0.0.1", port, socket: { data() {} } });
      sock.end();
      return true;
    } catch {
      await Bun.sleep(50);
    }
  }
  return false;
}

export interface StartRelayOptions {
  platform?: NodeJS.Platform;
  /** Overridden by tests; real callers let it find the install. */
  binaryPath?: string;
}

/**
 * Start a relay. Throws when MediaMTX is not installed, when it cannot bind, or when it does
 * not come up in time — never returns a handle to something that is not serving.
 */
export async function startRelay(opts: StartRelayOptions = {}): Promise<RelayHandle> {
  registerRelayExitSweep();

  const binary = opts.binaryPath ?? findMediamtxBinary(opts.platform ?? process.platform)?.path;
  if (!binary) throw new Error("the WebRTC relay is not installed");

  const [rtspPort, whepPort, iceUdpPort] = await Promise.all([
    freeTcpPort(), freeTcpPort(), freeUdpPort(),
  ]);
  const pathName = randomStreamPath();

  const configPath = mediamtxConfigPath(pathName);
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, buildMediamtxConfig({ rtspPort, whepPort, iceUdpPort, pathName }), {
    // The config names this session's stream path, which is a per-session secret.
    mode: 0o600,
  });

  const proc = Bun.spawn({
    cmd: [binary, configPath],
    stdout: "pipe", stderr: "pipe", windowsHide: true,
  });

  let stopped = false;
  // The file names this session's stream path, and nothing reads it once the relay is gone.
  const removeConfig = () => { try { rmSync(configPath, { force: true }); } catch { /* still held */ } };
  const handle: RelayHandle = {
    publishUrl: rtspPublishUrl(rtspPort, pathName),
    whepUrl: whepUrl(whepPort, pathName),
    pathName,
    stop() {
      if (stopped) return;
      stopped = true;
      active.delete(handle);
      try { proc.kill(); } catch { /* already gone */ }
      removeConfig();
    },
    isStopped: () => stopped,
  };
  active.add(handle);

  if (!(await waitUntilListening(whepPort))) {
    // MediaMTX prints the reason (a taken port, a rejected config key) and exits; hand that
    // text back rather than a bare timeout, because it names the actual fault every time.
    handle.stop();
    const why = (await new Response(proc.stderr).text()).trim()
      || (await new Response(proc.stdout).text()).trim();
    // The only reader of this message is the session's log line, and MediaMTX prefixes what it
    // says about a path with the path's name — this session's stream secret.
    const shown = why.split(pathName).join("[path]");
    throw new Error(`the WebRTC relay did not start${shown ? `: ${shown.slice(0, 300)}` : ""}`);
  }
  log.info(`mediamtx relay started pid=${proc.pid} rtsp=${rtspPort} whep=${whepPort} ice=${iceUdpPort}`);

  // Read for as long as the relay runs: it is what an unexpected exit is explained with, and a
  // pipe nobody reads fills up and blocks a relay that has something to say. Only a tail is kept.
  let output = "";
  const keepTail = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      output = (output + decoder.decode(value, { stream: true })).slice(-2_000);
    }
  };
  const drained = Promise.all([keepTail(proc.stdout), keepTail(proc.stderr)]).catch(() => {});

  // A relay that dies mid-session must not look alive to the rest of the code. The config is
  // removed once more after the exit, in case `stop` found it still open: Windows cannot delete
  // an open file.
  void proc.exited.then(async () => {
    const requested = stopped;
    handle.stop();
    removeConfig();
    if (requested) { log.debug(`mediamtx relay pid=${proc.pid} stopped`); return; }
    await drained;
    const tail = output.trim().split("\n").slice(-3).join(" | ").split(pathName).join("[path]");
    log.error(`mediamtx relay pid=${proc.pid} exited unexpectedly code=${proc.exitCode} signal=${proc.signalCode}: ${tail || "(no output)"}`);
  });

  return handle;
}

/** How many relays are serving right now. */
export function activeRelayCount(): number {
  return active.size;
}

/** Test seam and a safety net for teardown paths that lose their handle. */
export function stopAllRelays(): void {
  for (const r of [...active]) r.stop();
}
