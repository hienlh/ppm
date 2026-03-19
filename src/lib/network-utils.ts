import { networkInterfaces } from "node:os";

/** Return first non-internal IPv4 address, or null if none found */
export function getLocalIp(): string | null {
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] ?? []) {
      if (net.family === "IPv4" && !net.internal) return net.address;
    }
  }
  return null;
}
