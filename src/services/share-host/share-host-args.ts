/**
 * cloudflared argv for the share host's connector, and for PPM's own connector in `shared` mode.
 *
 * Each builder writes the files it names, like `named-tunnel-args.ts`, and no token ever appears
 * in argv: it travels in a 0600 file passed as `--token-file`. Every config is a file of PPM's
 * own, never `~/.cloudflared/config.yml`, whose ingress rules cloudflared would otherwise apply
 * (see `getQuickTunnelArgs`).
 *
 * A connector that carries more than one hostname routes them with ingress rules instead of
 * `--url`, and ends with a 404 for everything else: on PPM's tunnel with PPM's link off, that
 * 404 is what keeps PPM's own hostname from reaching PPM.
 */
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { getPpmDir } from "../ppm-dir.ts";
import { getQuickTunnelArgs } from "../cloudflared.service.ts";
import { writeNamedTunnelToken } from "../named-tunnel/named-tunnel-args.ts";

const shareRunConfigPath = () => resolve(getPpmDir(), "cloudflared-share.yml");
const shareTokenPath = () => resolve(getPpmDir(), "share-host-tunnel.token");
const sharedOwnConfigPath = () => resolve(getPpmDir(), "cloudflared-share-ingress.yml");
const ppmIngressConfigPath = () => resolve(getPpmDir(), "cloudflared-named-ingress.yml");

export interface IngressRule {
  hostname: string;
  /** Loopback port the hostname is served from. */
  port: number;
}

const HOSTNAME_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

/** A cloudflared config routing each hostname to its loopback port, and anything else to a 404. */
export function ingressConfigYaml(rules: IngressRule[]): string {
  const lines = ["no-autoupdate: true", "ingress:"];
  for (const rule of rules) {
    if (!HOSTNAME_RE.test(rule.hostname)) throw new Error(`invalid ingress hostname: ${rule.hostname}`);
    if (!Number.isInteger(rule.port) || rule.port <= 0 || rule.port > 65535) throw new Error(`invalid ingress port: ${rule.port}`);
    lines.push(`  - hostname: ${rule.hostname}`, `    service: http://127.0.0.1:${rule.port}`);
  }
  lines.push("  - service: http_status:404", "");
  return lines.join("\n");
}

function writePrivate(path: string, content: string): string {
  if (!existsSync(getPpmDir())) mkdirSync(getPpmDir(), { recursive: true, mode: 0o700 });
  writeFileSync(path, content, { mode: 0o600 });
  // POSIX enforces the mode; Windows has no equivalent bit.
  if (process.platform !== "win32") {
    try { chmodSync(path, 0o600); } catch {}
  }
  return path;
}

/** A temporary trycloudflare address for the worker: PPM's own quick argv, aimed at it. */
export function shareQuickArgs(port: number): string[] {
  return getQuickTunnelArgs(port);
}

/** The share host's own named tunnel, which carries nothing but the share host. */
export function shareNamedArgs(token: string, port: number): string[] {
  const cfg = writePrivate(shareRunConfigPath(), "no-autoupdate: true\n");
  const tokenPath = writePrivate(shareTokenPath(), token);
  return ["--config", cfg, "tunnel", "run", "--token-file", tokenPath, "--url", `http://127.0.0.1:${port}`];
}

/** A connector on PPM's tunnel while PPM's own link is off: the share hostname, and 404s. */
export function sharedOwnArgs(ppmToken: string, share: IngressRule): string[] {
  const cfg = writePrivate(sharedOwnConfigPath(), ingressConfigYaml([share]));
  return ["--config", cfg, "tunnel", "run", "--token-file", writeNamedTunnelToken(ppmToken)];
}

/** PPM's own connector while it also carries the share hostname. */
export function ppmIngressRunArgs(ppmToken: string, rules: IngressRule[]): string[] {
  const cfg = writePrivate(ppmIngressConfigPath(), ingressConfigYaml(rules));
  return ["--config", cfg, "tunnel", "run", "--token-file", writeNamedTunnelToken(ppmToken)];
}
