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
export async function sdNotify(state: string): Promise<void> {
  if (!process.env.NOTIFY_SOCKET) return; // not running under systemd
  try {
    const proc = Bun.spawn({
      cmd: ["systemd-notify", state],
      stdio: ["ignore", "ignore", "ignore"],
      env: process.env,
    });
    await proc.exited;
  } catch {
    // best-effort: if systemd-notify is missing, startup still proceeds
    // (Type=notify units without READY=1 will time out, but that's already
    // the failure mode — this helper doesn't make it worse).
  }
}
