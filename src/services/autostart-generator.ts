import { homedir } from "node:os";
import { resolve } from "node:path";

export interface AutoStartConfig {
  port: number;
  host: string;
  share: boolean;
  profile?: string;
}

/** Detect whether running from compiled binary or bun runtime */
export function isCompiledBinary(): boolean {
  // Compiled Bun binaries don't have "bun" in execPath
  return !process.execPath.includes("bun");
}

/** Resolve the absolute path to the bun binary */
export function resolveBunPath(): string {
  // 1. Current process is bun itself
  if (process.execPath.includes("bun")) return process.execPath;

  // 2. Check ~/.bun/bin/bun
  const home = homedir();
  const bunHome = resolve(home, ".bun", "bin", "bun");
  try {
    const { existsSync } = require("node:fs") as typeof import("node:fs");
    if (existsSync(bunHome)) return bunHome;
  } catch {}

  // 3. Check PATH via which/where
  try {
    const cmd = process.platform === "win32" ? ["where", "bun"] : ["which", "bun"];
    const result = Bun.spawnSync({ cmd, stdout: "pipe", stderr: "ignore" });
    const path = result.stdout.toString().trim().split("\n")[0];
    if (path) return path;
  } catch {}

  throw new Error("Could not resolve bun binary. Install Bun or add it to PATH.");
}

/** Build the command array for the PPM supervisor process */
export function buildExecCommand(config: AutoStartConfig): string[] {
  if (isCompiledBinary()) {
    // Compiled binary: just run self with __supervise__ args
    const args = [process.execPath, "__supervise__", String(config.port), config.host];
    if (config.profile) args.push(config.profile);
    if (config.share) args.push("--share");
    return args;
  }

  // Bun runtime: bun run <script> __supervise__ <port> <host> [profile]
  const bunPath = resolveBunPath();
  const scriptPath = resolve(import.meta.dir, "supervisor.ts");
  const args = [bunPath, "run", scriptPath, "__supervise__", String(config.port), config.host];
  if (config.profile) args.push(config.profile);
  if (config.share) args.push("--share");
  return args;
}

// ─── macOS launchd plist ────────────────────────────────────────────────

const PLIST_LABEL = "com.hienlh.ppm";

export function getPlistPath(): string {
  return resolve(homedir(), "Library", "LaunchAgents", `${PLIST_LABEL}.plist`);
}

/**
 * PATH for the launchd job: bun's directory first, then whatever the shell
 * running `ppm start` / `ppm autostart enable` had, then the standard dirs.
 * Deduplicated, order preserved. Exported for tests.
 */
export function buildLaunchdPath(shellPath: string | undefined = process.env.PATH): string {
  const bunDir = isCompiledBinary() ? "" : resolve(resolveBunPath(), "..");
  const candidates = [
    bunDir,
    ...(shellPath ?? "").split(":"),
    "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin",
  ];
  return [...new Set(candidates.filter(Boolean))].join(":");
}

/** Generate macOS launchd plist XML content */
export function generatePlist(config: AutoStartConfig): string {
  const cmd = buildExecCommand(config);
  const logPath = resolve(homedir(), ".ppm", "ppm-launchd.log");

  const programArgs = cmd
    .map((arg) => `        <string>${escapeXml(arg)}</string>`)
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${PLIST_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
${programArgs}
    </array>
    <!-- launchd's GUI domain PATH is /usr/bin:/bin:/usr/sbin:/sbin. Every
         \`ppm start\` on macOS now runs here, so carry the invoking shell's PATH
         (bun, homebrew, node) or chat Bash tools and the tunnel binary lookup
         lose what the user has in their terminal. -->
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${escapeXml(buildLaunchdPath())}</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <!-- No AbandonProcessGroup: upgrades exit and let KeepAlive restart us, so
         there is no replacement to protect. Letting launchd tear down the
         process group is what reaps the server and its Claude SDK children —
         abandoning it orphaned them holding the listening socket, which forced
         the next supervisor onto a fallback port and left a duplicate behind. -->
    <key>StandardOutPath</key>
    <string>${escapeXml(logPath)}</string>
    <key>StandardErrorPath</key>
    <string>${escapeXml(logPath)}</string>
    <key>WorkingDirectory</key>
    <string>${escapeXml(resolve(homedir(), ".ppm"))}</string>
    <key>ThrottleInterval</key>
    <integer>10</integer>
</dict>
</plist>
`;
}

// ─── Linux systemd service ──────────────────────────────────────────────

export function getServicePath(): string {
  return resolve(homedir(), ".config", "systemd", "user", "ppm.service");
}

/** Generate Linux systemd user service file content */
export function generateSystemdService(config: AutoStartConfig): string {
  const cmd = buildExecCommand(config);
  const execStart = cmd.map(shellEscape).join(" ");
  const bunDir = isCompiledBinary() ? "" : resolve(resolveBunPath(), "..");

  // Build PATH with bun directory prepended
  const envPath = bunDir
    ? `Environment="PATH=${bunDir}:/usr/local/bin:/usr/bin:/bin"`
    : "";

  return `[Unit]
Description=PPM - Personal Project Manager
Documentation=https://github.com/hienlh/ppm
After=network-online.target
Wants=network-online.target

[Service]
Type=notify
NotifyAccess=all
ExecStart=${execStart}
Restart=always
RestartSec=3
TimeoutStartSec=60
TimeoutStopSec=10
KillMode=mixed
${envPath}
WorkingDirectory=${homedir()}/.ppm

[Install]
WantedBy=default.target
`;
}

// ─── Windows Registry Run key ───────────────────────────────────────────
// Uses HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\Run — no admin needed

const TASK_NAME = "PPM";
const WIN_REG_KEY = "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run";

/** Generate Windows VBScript wrapper content to run PPM hidden */
export function generateVbsWrapper(config: AutoStartConfig): string {
  const cmd = buildExecCommand(config);
  const exe = cmd[0]!;
  const args = cmd.slice(1).join(" ");
  return `Set objShell = CreateObject("WScript.Shell")
objShell.Run """${exe.replace(/\\/g, "\\\\")}""` +
    ` ${args.replace(/"/g, '""')}", 0, False
`;
}

export function getVbsPath(): string {
  return resolve(homedir(), ".ppm", "run-ppm.vbs");
}

/** Build reg command to remove the legacy PPM Run-key entry (migration cleanup) */
export function buildRegDeleteCommand(): string[] {
  return [
    "reg", "delete", WIN_REG_KEY,
    "/v", TASK_NAME,
    "/f",
  ];
}

// ─── Windows Task Scheduler (At-logon) ──────────────────────────────────
// Preferred over the HKCU Run key: fires reliably at logon and is not swept
// by third-party "startup cleaner" utilities that only target Run keys and
// the Startup folder. No admin required for a current-user logon task.

/**
 * The account the task runs as, and whose logon fires it — `DOMAIN\user`, or
 * bare user name when the machine reports no domain.
 */
export function getCurrentWindowsUserId(): string {
  const user = process.env.USERNAME ?? "";
  const domain = process.env.USERDOMAIN ?? process.env.COMPUTERNAME ?? "";
  return domain ? `${domain}\\${user}` : user;
}

export function getTaskXmlPath(): string {
  return resolve(homedir(), ".ppm", "ppm-task.xml");
}

/**
 * Task Scheduler XML for the At-logon task.
 *
 * `schtasks /SC ONLOGON` cannot express *which* user's logon fires the task:
 * it always emits a LogonTrigger with no UserId, meaning "any user logs on",
 * and registering that is an all-users change the Task Scheduler refuses for a
 * standard account — the create fails with "ERROR: Access is denied." even
 * when /RU names the caller, because /RU sets the run-as principal, not the
 * trigger scope. Registering from XML lets the trigger carry a UserId, which
 * scopes it to this account and needs no elevation.
 *
 * ExecutionTimeLimit must be PT0S (unlimited): schtasks would have defaulted to
 * PT72H and killed the supervisor after three days of uptime.
 */
export function generateTaskXml(vbsPath: string, userId = getCurrentWindowsUserId()): string {
  const user = escapeXml(userId);
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>PPM - starts the PPM supervisor at logon</Description>
    <URI>\\${TASK_NAME}</URI>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${user}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${user}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>false</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>wscript.exe</Command>
      <Arguments>"${escapeXml(vbsPath)}"</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

/** Build schtasks command to create the At-logon task from XML (no admin) */
export function buildSchtasksCreateCommand(xmlPath: string): string[] {
  return [
    "schtasks", "/Create",
    "/TN", TASK_NAME,
    "/XML", xmlPath,
    "/F",
  ];
}

/** Build schtasks command to delete the PPM task */
export function buildSchtasksDeleteCommand(): string[] {
  return ["schtasks", "/Delete", "/TN", TASK_NAME, "/F"];
}

/** Build schtasks command to query the PPM task */
export function buildSchtasksQueryCommand(): string[] {
  return ["schtasks", "/Query", "/TN", TASK_NAME];
}

// ─── Helpers ────────────────────────────────────────────────────────────

/** Escape special XML characters */
function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Escape a string for shell usage (wrap in quotes if contains spaces) */
function shellEscape(s: string): string {
  if (/["\s]/.test(s)) return `"${s.replace(/"/g, '\\"')}"`;
  return s;
}

export { PLIST_LABEL, TASK_NAME };
