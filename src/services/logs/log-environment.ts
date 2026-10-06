/**
 * The Environment block of a bug report: what PPM, the host, the Claude Agent SDK and the tunnel
 * are. The browser line is added by the page, which is the one that knows it. Nothing here names
 * the person or the machine: no hostname, no tunnel address, no paths.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { arch, platform, release, version as osVersion } from "node:os";
import pkg from "../../../package.json";
import { VERSION } from "../../version.ts";
import { getConfigValue } from "../db.service.ts";
import { getCloudflaredPath } from "../cloudflared.service.ts";
import { resolveTunnelConfig } from "../named-tunnel/named-tunnel-config.ts";
import { tunnelService } from "../tunnel.service.ts";

let cloudflaredVersion: { path: string; mtimeMs: number; value: string | null } | null = null;

function linuxDistro(): string | null {
  try {
    const text = readFileSync("/etc/os-release", "utf8");
    const name = /^NAME="?([^"\n]+)"?/m.exec(text)?.[1];
    return name?.trim() || null;
  } catch {
    return null;
  }
}

/** A missing binary makes `Bun.spawn` throw, hence the check and the `try`. */
async function runQuiet(cmd: string[], timeoutMs = 3000): Promise<string | null> {
  if (!existsSync(cmd[0]!)) return null;
  try {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", timeout: timeoutMs });
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    await proc.exited;
    return `${out}${err}`.trim() || null;
  } catch {
    return null;
  }
}

async function hostLine(): Promise<string> {
  const os = platform();
  let name: string;
  if (os === "linux") {
    const distro = linuxDistro();
    name = `Linux ${release().split("-")[0]}${distro ? ` (${distro})` : ""}`;
  } else if (os === "darwin") {
    name = `macOS ${(await runQuiet(["/usr/bin/sw_vers", "-productVersion"])) ?? `(Darwin ${release()})`}`;
  } else if (os === "win32") {
    name = `${osVersion() || "Windows"} ${release()}`;
  } else {
    name = `${os} ${release()}`;
  }
  return `${name}, ${arch()}, Bun ${Bun.version}`;
}

async function cloudflaredLine(): Promise<string | null> {
  const path = getCloudflaredPath();
  let mtimeMs: number;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    return null;
  }
  if (!cloudflaredVersion || cloudflaredVersion.path !== path || cloudflaredVersion.mtimeMs !== mtimeMs) {
    const out = await runQuiet([path, "--version"]);
    cloudflaredVersion = { path, mtimeMs, value: out ? /version (\S+)/.exec(out)?.[1] ?? null : null };
  }
  return cloudflaredVersion.value ? `cloudflared ${cloudflaredVersion.value}` : "cloudflared";
}

async function tunnelLine(): Promise<string> {
  const cfg = resolveTunnelConfig(getConfigValue("tunnel"));
  const binary = await cloudflaredLine();
  if (!cfg.enabled) return binary ? `${binary}, off` : "off";
  const running = !!tunnelService.getTunnelUrl();
  const mode = cfg.mode === "named" ? "named tunnel" : "quick tunnel";
  return [binary, running ? mode : `${mode}, not running`].filter(Boolean).join(", ");
}

/** `[label, value]` rows, in the order the report shows them (the page puts Browser after Host). */
export async function logEnvironment(): Promise<[string, string][]> {
  const sdk = (pkg as { dependencies?: Record<string, string> }).dependencies?.["@anthropic-ai/claude-agent-sdk"];
  const rows: [string, string][] = [
    ["PPM", `v${VERSION}`],
    ["Host", await hostLine()],
  ];
  if (sdk) rows.push(["Claude Agent SDK", sdk.replace(/^[\^~]/, "")]);
  try {
    rows.push(["Tunnel", await tunnelLine()]);
  } catch {
    /* no config yet: leave the row out */
  }
  return rows;
}
