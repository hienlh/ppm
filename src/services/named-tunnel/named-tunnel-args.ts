/**
 * cloudflared argv builders for the named-tunnel flow, plus the two artifact
 * files they depend on. Every builder here guarantees its own artifacts (mirrors
 * `cloudflared.service.ts`'s `getQuickTunnelArgs` → `ensureQuickTunnelConfig`
 * pattern) rather than assuming an earlier phase already created them.
 *
 * The run token never appears in argv, ever — it is written to a 0600 file and
 * passed via `--token-file`, so it can't leak through `ppm status`, a process
 * list, or a crash dump that captures cmdlines.
 */
import { resolve } from "node:path";
import { hostname as osHostname } from "node:os";
import { existsSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { getPpmDir } from "../ppm-dir.ts";
import { getOriginCertPath } from "./cloudflared-cert.ts";

const namedTunnelConfigPath = () => resolve(getPpmDir(), "cloudflared-named.yml");
const namedTunnelTokenPath = () => resolve(getPpmDir(), "named-tunnel.token");
const isWindows = process.platform === "win32";

/**
 * Ensure `getPpmDir()` exists without letting a pre-existing directory throw
 * EEXIST (Windows read-only-attribute folders — Desktop/Documents/Downloads —
 * have thrown on a recursive mkdir here before even though the dir was already
 * present and usable).
 */
function ensurePpmDir(): void {
  if (existsSync(getPpmDir())) return;
  try {
    mkdirSync(getPpmDir(), { recursive: true, mode: 0o700 });
  } catch (e: any) {
    if (e?.code !== "EEXIST") throw e;
  }
}

/** Best-effort chmod — POSIX enforces the mode; Windows has no equivalent bit. */
function chmodBestEffort(path: string, mode: number): void {
  if (isWindows) return;
  try { chmodSync(path, mode); } catch {}
}

/**
 * Create `~/.ppm/cloudflared-named.yml` if absent; returns its path.
 * A comment-only file still parses but logs `ERR Configuration file ... was
 * empty` on every command (harmless noise, verified live); a *missing* file
 * exits 1. `no-autoupdate: true` is a real, valid key so the file is never
 * comment-only.
 */
export function ensureNamedTunnelConfig(): string {
  const path = namedTunnelConfigPath();
  if (!existsSync(path)) {
    ensurePpmDir();
    writeFileSync(path, "no-autoupdate: true\n", { mode: 0o600 });
  }
  chmodBestEffort(path, 0o600);
  return path;
}

/** Write the run token to a 0600 file; returns its path. Overwritten on every call. */
export function writeNamedTunnelToken(token: string): string {
  ensurePpmDir();
  const path = namedTunnelTokenPath();
  writeFileSync(path, token, { mode: 0o600 });
  chmodBestEffort(path, 0o600);
  return path;
}

/** `tunnel login` has no cert yet, so no `--origincert` — that flag would point nowhere. */
export function loginArgs(): string[] {
  return ["tunnel", "login"];
}

/** Global flags (`--origincert`/`--config`) always precede the subcommand. */
function managementPrefix(): string[] {
  return ["--origincert", getOriginCertPath(), "--config", ensureNamedTunnelConfig()];
}

export function createTunnelArgs(name: string): string[] {
  return [...managementPrefix(), "tunnel", "create", name];
}

export function tunnelTokenArgs(name: string): string[] {
  return [...managementPrefix(), "tunnel", "token", name];
}

/**
 * `--overwrite-dns` only when the caller has confirmed this is our own tunnel's
 * UUID being re-pointed (e.g. after a reset) — never passed blindly, since it
 * silently steals a CNAME that might belong to something else.
 */
export function routeDnsArgs(name: string, hostname: string, overwrite: boolean): string[] {
  const flags = overwrite ? ["--overwrite-dns"] : [];
  return [...managementPrefix(), "tunnel", "route", "dns", ...flags, name, hostname];
}

/**
 * Argv for the long-running named-tunnel process. No `--token` literal ever
 * appears here — only a path to a 0600 file cloudflared reads itself.
 */
export function namedRunArgs(token: string, port: number): string[] {
  const cfg = ensureNamedTunnelConfig();
  const tokenPath = writeNamedTunnelToken(token);
  return ["--config", cfg, "tunnel", "run", "--token-file", tokenPath, "--url", `http://127.0.0.1:${port}`];
}

/** Stable, DNS-safe tunnel name derived from this machine's hostname. */
export function tunnelNameForHost(): string {
  const sanitized = osHostname().toLowerCase().replace(/[^a-z0-9-]/g, "-");
  return `ppm-${sanitized}`.slice(0, 32);
}
