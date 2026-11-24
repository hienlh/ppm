/**
 * Ports of PPM itself that pages in PPM's browser must never reach, on any address of this
 * machine: PPM listens on 0.0.0.0, so `<LAN IP>:<port>` is PPM just as much as `127.0.0.1:<port>`.
 * A page on PPM's own origin could read PPM's token from the browser's storage if one were ever
 * saved there, and the API answers loopback callers.
 */
import { configService } from "../config.service.ts";
import { getForwardedShareHosts } from "../design/share/design-share-address.ts";

const runtimePorts = new Set<number>();

/** Called by whatever opens a listener PPM owns (the server's real port, a relay). */
export function registerPpmOwnPort(port: number): void {
  if (Number.isInteger(port) && port > 0 && port < 65536) runtimePorts.add(port);
}

export function unregisterPpmOwnPort(port: number): void {
  runtimePorts.delete(port);
}

/** PPM's public names (its tunnel and the share host), without ports: they lead back to PPM too. */
export function ppmOwnHostNames(): string[] {
  try {
    return [...new Set(getForwardedShareHosts().map((h) => h.replace(/:\d+$/, "").toLowerCase()))];
  } catch {
    return [];
  }
}

export function ppmOwnPorts(): number[] {
  const ports = new Set(runtimePorts);
  try {
    const configured = Number(configService.get("port"));
    if (Number.isInteger(configured) && configured > 0) ports.add(configured);
  } catch {}
  return [...ports];
}
