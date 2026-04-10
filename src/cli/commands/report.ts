import { platform, arch, release } from "node:os";
import { resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { getRecentLogs } from "./logs.ts";
import { getPpmDir } from "../../services/ppm-dir.ts";

const REPO = "hienlh/ppm";

export async function reportBug() {
  const { VERSION: version } = await import("../../version.ts");
  const logs = getRecentLogs(30);
  const statusFile = resolve(getPpmDir(), "status.json");
  let statusInfo = "(not running)";
  if (existsSync(statusFile)) {
    try { statusInfo = readFileSync(statusFile, "utf-8"); } catch {}
  }

  const body = [
    "## Environment",
    `- PPM: v${version}`,
    `- OS: ${platform()} ${arch()} ${release()}`,
    `- Bun: ${Bun.version}`,
    "",
    "## Description",
    "<!-- Describe the bug -->",
    "",
    "## Steps to Reproduce",
    "1. ",
    "",
    "## Expected Behavior",
    "",
    "## Daemon Status",
    "```json",
    statusInfo,
    "```",
    "",
    "## Recent Logs (last 30 lines)",
    "```",
    logs,
    "```",
  ].join("\n");

  const title = encodeURIComponent("bug: ");
  const encodedBody = encodeURIComponent(body);
  const url = `https://github.com/${REPO}/issues/new?title=${title}&body=${encodedBody}`;

  console.log("  Opening GitHub issue form in browser...\n");
  console.log("  Environment info and recent logs will be pre-filled.\n");

  const { $ } = await import("bun");
  try {
    if (platform() === "darwin") {
      await $`open ${url}`.quiet();
    } else {
      await $`xdg-open ${url}`.quiet();
    }
  } catch {
    console.log("  Could not open browser. Copy this URL:\n");
    console.log(`  ${url}\n`);
  }
}
