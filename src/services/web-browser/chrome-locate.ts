/**
 * Which Chromium-based browser PPM can run, per OS. Only real files are returned, each proved by
 * running it with `--version`, because the chosen path is a program PPM will execute: Settings
 * offers exactly this list and never a free-text path.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "../logger.ts";

const log = createLogger("web-browser");

export interface FoundBrowser {
  path: string;
  name: string;
  version: string;
}

function candidatePaths(): { path: string; name: string }[] {
  const env = process.env;
  if (process.platform === "win32") {
    const roots = [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA].filter((r): r is string => !!r);
    return roots.flatMap((root) => [
      { path: join(root, "Google", "Chrome", "Application", "chrome.exe"), name: "Google Chrome" },
      { path: join(root, "Microsoft", "Edge", "Application", "msedge.exe"), name: "Microsoft Edge" },
      { path: join(root, "Chromium", "Application", "chrome.exe"), name: "Chromium" },
    ]);
  }
  if (process.platform === "darwin") {
    return [
      { path: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", name: "Google Chrome" },
      { path: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", name: "Microsoft Edge" },
      { path: "/Applications/Chromium.app/Contents/MacOS/Chromium", name: "Chromium" },
    ];
  }
  const fromPath = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge"]
    .map((cmd) => ({ path: Bun.which(cmd) ?? "", name: cmd }))
    .filter((c) => c.path !== "");
  return [...fromPath, { path: "/usr/bin/google-chrome", name: "Google Chrome" }, { path: "/snap/bin/chromium", name: "Chromium" }];
}

/** Asks the binary for its version; null when it does not run. */
async function versionOf(path: string): Promise<string | null> {
  if (process.platform === "win32") {
    // chrome.exe --version prints nothing on Windows; the folder next to it is named after the version.
    const { readdirSync } = await import("node:fs");
    const { dirname } = await import("node:path");
    try {
      const v = readdirSync(dirname(path)).find((n) => /^\d+\.\d+\.\d+\.\d+$/.test(n));
      return v ?? "unknown";
    } catch {
      return null;
    }
  }
  try {
    const proc = Bun.spawn([path, "--version"], { stdout: "pipe", stderr: "ignore" });
    const timer = setTimeout(() => { try { proc.kill(); } catch {} }, 5000);
    const out = await new Response(proc.stdout).text();
    clearTimeout(timer);
    return (await proc.exited) === 0 ? (out.trim().match(/[\d.]+/)?.[0] ?? out.trim()) : null;
  } catch {
    return null;
  }
}

let cached: { at: number; list: FoundBrowser[] } | null = null;

/** Every browser found, best first. Cached for a minute: Settings asks on each open. */
export async function findBrowsers(): Promise<FoundBrowser[]> {
  if (cached && Date.now() - cached.at < 60_000) return cached.list;
  const seen = new Set<string>();
  const list: FoundBrowser[] = [];
  for (const c of candidatePaths()) {
    const key = c.path.toLowerCase();
    if (seen.has(key) || !existsSync(c.path)) continue;
    seen.add(key);
    const version = await versionOf(c.path);
    if (version) list.push({ ...c, version });
    else log.warn(`${c.name} at ${c.path} did not run with --version; not offered`);
  }
  cached = { at: Date.now(), list };
  return list;
}

/** The browser to run: the configured one if it is still among those found, else the first. */
export async function pickBrowser(configured: string | null): Promise<FoundBrowser | null> {
  const list = await findBrowsers();
  if (configured) {
    const match = list.find((b) => b.path.toLowerCase() === configured.toLowerCase());
    if (match) return match;
  }
  return list[0] ?? null;
}

/** What to tell the user when nothing was found. */
export function installHint(): string {
  if (process.platform === "win32") return "Install Google Chrome or Microsoft Edge.";
  if (process.platform === "darwin") return "Install Google Chrome (brew install --cask google-chrome).";
  return "Install Chromium or Google Chrome (for example: sudo apt install chromium).";
}

export function resetBrowserCacheForTest(): void {
  cached = null;
}
