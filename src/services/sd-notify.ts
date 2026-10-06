/**
 * sd_notify helper — forwards messages to systemd via the `systemd-notify` binary.
 * No-op on non-systemd platforms (NOTIFY_SOCKET unset).
 *
 * Usage:
 *   await sdNotify("READY=1");                   // mark unit active (Type=notify)
 *   await sdNotify(`MAINPID=${newPid}`);         // handoff main process (NotifyAccess=all)
 *
 * Shelling out to `systemd-notify` avoids implementing AF_UNIX SOCK_DGRAM
 * transport in Node/Bun (not supported by node:dgram). The binary ships with
 * systemd itself, so availability matches systemd availability.
 */
import { createLogger } from "./logger.ts";

const log = createLogger("sd-notify");

export async function sdNotify(state: string): Promise<void> {
  if (!process.env.NOTIFY_SOCKET) return; // not running under systemd
  try {
    const proc = Bun.spawn({
      cmd: ["systemd-notify", state],
      stdio: ["ignore", "ignore", "ignore"],
      env: process.env,
    });
    const code = await proc.exited;
    // A lost READY=1 ends with systemd killing the unit at TimeoutStartSec, and nothing
    // else in ppm.log would say why.
    if (code !== 0) log.warn(`sd_notify ${state} failed (exit ${code}) — systemd may time the unit out`);
    else log.debug(`sd_notify ${state} sent`);
  } catch (e) {
    // best-effort: if systemd-notify is missing, startup still proceeds
    // (Type=notify units without READY=1 will time out, but that's already
    // the failure mode — this helper doesn't make it worse).
    log.warn(`sd_notify ${state} failed (${e instanceof Error ? e.message : e}) — systemd may time the unit out`);
  }
}
