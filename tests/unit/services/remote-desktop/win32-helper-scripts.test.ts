import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  encodePowerShell, isAscii, isUserSid, parseWhoamiUserCsv, psQuote,
} from "../../../../src/services/remote-desktop/win32-helper/powershell-text.ts";
import {
  buildHelperScript, REATTACH_ACTION, WTS_SESSION_LOOKUP,
} from "../../../../src/services/remote-desktop/win32-helper/helper-script.ts";
import { readWindowsSession } from "../../../../src/services/remote-desktop/remote-desktop-win32-session.ts";
import { HELPER_ACTIONS, whoamiExe } from "../../../../src/services/remote-desktop/win32-helper/helper-paths.ts";
import { helperInstallPlan } from "../../../../src/services/remote-desktop/win32-helper/helper-install-plan.ts";
import { CREATE_DEVICE_TYPE } from "../../../../src/services/remote-desktop/win32-helper/vdd-scripts.ts";
import { HARDWARE_MONITOR_QUERY } from "../../../../src/services/remote-desktop/win32-helper/hardware-monitor-count.ts";
import {
  buildBootstrap, buildElevationLauncher, buildInstallScript, buildUninstallScript, SYSTEM_ONLY_SDDL, userTaskSddl,
} from "../../../../src/services/remote-desktop/win32-helper/install-script.ts";

const SID = "S-1-5-21-1111111111-2222222222-3333333333-1001";
const HASH = "a".repeat(64);

describe("PowerShell text helpers", () => {
  it("doubles every kind of single quote PowerShell honours", () => {
    expect(psQuote("C:\\Users\\O'Brien")).toBe("'C:\\Users\\O''Brien'");
    expect(psQuote("O\u2019Brien")).toBe("'O\u2019\u2019Brien'");
  });

  it("accepts only interactive account SIDs", () => {
    expect(isUserSid(SID)).toBe(true);
    expect(isUserSid("S-1-5-18")).toBe(false);
    expect(isUserSid("S-1-5-32-544")).toBe(false);
    expect(isUserSid(`${SID}'; Remove-Item C:\\ -Recurse; '`)).toBe(false);
  });

  it("reads the SID from whoami's header-less CSV, whatever the display language", () => {
    expect(parseWhoamiUserCsv(`"hien-pc\\pc","${SID}"\r\n`)).toBe(SID);
    expect(parseWhoamiUserCsv('"nt authority\\system","S-1-5-18"')).toBeNull();
    expect(parseWhoamiUserCsv("")).toBeNull();
  });
});

describe("helper.ps1", () => {
  const script = buildHelperScript(SID, [REATTACH_ACTION]);

  it("is ASCII, so PowerShell 5.1 reads exactly the bytes that were hashed", () => {
    expect(isAscii(script)).toBe(true);
  });

  it("takes one parameter restricted to the known actions, and nothing else", () => {
    expect(script).toContain("[ValidateSet('Reattach')]");
    expect(script).not.toMatch(/\$args\b/);
    expect(script).not.toMatch(/\$input\b/i);
    // One script-level param block (the safety net's script blocks take their own, internal ones).
    expect((script.match(/^param\(/gm) ?? []).length).toBe(1);
    expect(script.indexOf("param(\n  [Parameter(Mandatory = $true)]")).toBeLessThan(script.indexOf("function "));
  });

  it("acts only on the user whose SID was written in, found through WTS rather than quser", () => {
    expect(script).toContain(`$UserSid = '${SID}'`);
    expect(script).toContain("WTSEnumerateSessionsW");
    expect(script).not.toMatch(/\bquser\b|\bqwinsta\b|query session/i);
    expect(script).toContain("if ($sid -eq $UserSid)");
  });

  it("moves a session only when exactly one disconnected session of that user exists", () => {
    expect(script).toContain("$_.State -eq 4");
    expect(script).toContain("$disconnected.Count -gt 1");
    expect(script).toContain("& $tscon $Id /dest:console");
  });

  it("writes only inside its own state folder and never through a reparse point", () => {
    const writes = script.match(/WriteAllText\(\$\w+/g) ?? [];
    expect(writes).toEqual(["WriteAllText($tmp"]);
    expect(script).toContain("Assert-NotReparse $target");
    expect(script).toContain("$StateDir = Join-Path $PSScriptRoot 'state'");
  });

  it("records when the run started, how long it took and how long it waited for the lock", () => {
    // Two runs on a real host took 20 s and 27 s against a usual 0.5-3 s, and the log could not
    // say whether Windows started the task late or the work itself was slow.
    expect(script.indexOf("$RunStartedAt = [DateTime]::UtcNow")).toBeLessThan(script.indexOf("function "));
    expect(script).toContain("startedAt = $RunStartedAt; ms = $ms; lockMs = $LockMs");
    expect(script).toContain("' started=' + $RunStartedAt + ' ms=' + $ms + ' lockMs=' + $LockMs");
    expect(script.indexOf("$beforeLock = ")).toBeLessThan(script.indexOf("$mutex.WaitOne("));
  });

  it("runs one action at a time, and always lets go of the lock", () => {
    const wait = script.indexOf("$mutex.WaitOne(");
    expect(wait).toBeGreaterThan(0);
    expect(wait).toBeLessThan(script.indexOf("switch ($Action)"));
    expect(script).toMatch(/finally \{\n\s+if \(\$held\) \{ \$mutex\.ReleaseMutex\(\) \}/);
    expect(script.trimEnd().endsWith("exit $code")).toBe(true);
  });

  it("refuses to be built for anything but a user SID", () => {
    expect(() => buildHelperScript("S-1-5-18", [REATTACH_ACTION])).toThrow();
  });
});

describe("install.ps1 / uninstall.ps1", () => {
  const install = buildInstallScript({ userSid: SID, actions: ["Reattach"] });

  it("gives the task to SYSTEM and lets only the PPM user read and start it", () => {
    expect(install).toContain(`'D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;GRGX;;;${SID})'`);
    expect(install).toContain("-UserId 'S-1-5-18'");
    expect(install).toContain("-MultipleInstances IgnoreNew");
  });

  it("lets the PPM user start only what PPM starts; the safety net is SYSTEM's alone", () => {
    const full = buildInstallScript({ userSid: SID, actions: [...HELPER_ACTIONS] });
    expect(full).toContain(`$sddl = '${SYSTEM_ONLY_SDDL}'`);
    expect(full).toContain("if (@('Reattach', 'DisplayOn', 'DisplayOff', 'Confirm') -contains $action)");
    expect(userTaskSddl(SID)).toBe(`D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;GRGX;;;${SID})`);
    expect(SYSTEM_ONLY_SDDL).not.toContain("S-1-5-21");
    expect(() => userTaskSddl("S-1-1-0")).toThrow();
  });

  it("runs PowerShell by absolute path with a fixed command line", () => {
    expect(install).toContain("Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'");
    expect(install).toContain("'\" -Action ' + $action");
    expect(install).toContain("foreach ($action in @('Reattach'))");
  });

  it("sets the folder's ACL without pushing folder-only grants onto files", () => {
    // Found on a real host: `/inheritance:r /grant:r ...(OI)(CI)... /T` left every existing file
    // with an empty ACL and exit code 0, so a reinstall could not overwrite helper.ps1.
    const grant = install.split("\n").find((l) => l.includes("/inheritance:r"))!;
    expect(grant).not.toContain("/T");
    expect(install).toContain("(Join-Path $Path '*') /reset /T /C /Q");
  });

  it("locks the folder down by group SID, never by a translated group name", () => {
    expect(install).toContain("/inheritance:r");
    expect(install).toContain("'*S-1-5-32-545:(OI)(CI)RX'");
    expect(install).not.toMatch(/\b(Administrators|Users|SYSTEM):/);
  });

  it("uses a folder of its own, never one named after PPM's autostart task", () => {
    // Found on a real host: `\PPM` is PPM's own autostart task, so a `\PPM\RemoteDesktop\`
    // folder can never exist ("path not found", then "already exists").
    expect(install).toContain("$TaskFolderName = 'PPM-RemoteDesktop'");
    expect(install).toContain("$root.CreateFolder($TaskFolderName)");
    expect(install.indexOf("CreateFolder")).toBeLessThan(install.indexOf("Register-ScheduledTask -TaskName"));
    expect(install).not.toMatch(/'PPM'/);
  });

  it("uninstall deletes only its own task folder, never anything named PPM", () => {
    const un = buildUninstallScript({ actions: ["Reattach"] });
    expect(un).toContain("DeleteFolder($TaskFolderName, 0)");
    expect(un).not.toMatch(/DeleteFolder\('PPM'|GetFolder\('\\PPM'\)/);
  });

  it("writes the helper from the verified bytes, not from the staged file", () => {
    expect(install).toContain("[IO.File]::WriteAllBytes($HelperPath, $HelperBytes)");
  });

  it("uninstall removes every task and the folder", () => {
    const un = buildUninstallScript({ actions: ["Reattach"] });
    expect(un).toContain("Unregister-ScheduledTask -TaskName $action -TaskPath $TaskPath");
    expect(un).toContain("Remove-Item -LiteralPath $InstallDir -Recurse -Force");
    expect(isAscii(un) && isAscii(install)).toBe(true);
  });
});

describe("bootstrap and elevation launcher", () => {
  const staged = { variable: "HelperBytes", path: "C:\\Users\\O'Brien\\.ppm\\remote-desktop-helper\\helper.ps1", sha256: HASH };
  const script = { variable: "ScriptBytes", path: "C:\\x\\install.ps1", sha256: "b".repeat(64) };

  it("verifies each payload's hash on the bytes it then uses", () => {
    const boot = buildBootstrap([staged], script);
    expect(boot).toContain(`$HelperBytes = Read-Verified 'C:\\Users\\O''Brien\\.ppm\\remote-desktop-helper\\helper.ps1' '${HASH}'`);
    expect(boot).toContain("GetString($ScriptBytes)");
    expect(boot).not.toMatch(/-File\b|Get-Content/);
  });

  it("rejects a malformed hash or variable instead of building a script around it", () => {
    expect(() => buildBootstrap([{ ...staged, sha256: "zz" }], script)).toThrow();
    expect(() => buildBootstrap([{ ...staged, variable: "x; rm" }], script)).toThrow();
  });

  it("fits the Windows command line with a full-size installer", () => {
    const boot = buildBootstrap([staged, { ...staged, variable: "VddZipBytes" }], script);
    const launcher = buildElevationLauncher("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", encodePowerShell(boot));
    expect(encodePowerShell(launcher).length).toBeLessThan(30_000);
    expect(() => buildElevationLauncher("x", "not base64!")).toThrow();
  });
});

/** Parse every generated script with PowerShell's own parser (read-only: nothing runs). Only on
 *  Windows, where PowerShell 5.1 — the version the tasks use — is present. */
describe.if(process.platform === "win32")("generated scripts parse in Windows PowerShell", () => {
  it("has no syntax errors", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ppm-helper-parse-"));
    // The full install as shipped: all three actions plus the driver steps.
    const plan = helperInstallPlan();
    const files = {
      "helper.ps1": plan.buildHelper(SID),
      "install.ps1": buildInstallScript({ userSid: SID, actions: plan.actions, extraSteps: plan.installSteps }),
      "uninstall.ps1": buildUninstallScript({ actions: plan.actions, extraSteps: plan.uninstallSteps }),
      "bootstrap.ps1": buildBootstrap([{ variable: "HelperBytes", path: "C:\\a", sha256: HASH }], { variable: "ScriptBytes", path: "C:\\b", sha256: HASH }),
      // PPM's own read of the helper's monitor definition (Windows' fallback screen).
      "hardware-monitors.ps1": HARDWARE_MONITOR_QUERY,
    };
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
    const check = `$bad = 0; foreach ($f in Get-ChildItem -LiteralPath ${psQuote(dir)} -Filter *.ps1) {
  $tokens = $null; $errors = $null
  [void][System.Management.Automation.Language.Parser]::ParseFile($f.FullName, [ref]$tokens, [ref]$errors)
  foreach ($e in $errors) { $bad++; Write-Output ($f.Name + ': ' + $e.Message) } }
exit $bad`;
    const proc = Bun.spawn(["powershell.exe", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShell(check)], { stdout: "pipe", stderr: "pipe" });
    const out = await new Response(proc.stdout).text();
    expect(out.trim()).toBe("");
    expect(await proc.exited).toBe(0);
  }, 60_000);

  // Compiles the device-creation C# exactly as the installer embeds it. Add-Type only compiles;
  // nothing is called, so no device is created.
  it("the device-creation C# compiles", async () => {
    const probe = `$ErrorActionPreference = 'Stop'
${CREATE_DEVICE_TYPE}
[bool]('PpmRootDevice' -as [type])`;
    const proc = Bun.spawn(["powershell.exe", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShell(probe)], { stdout: "pipe", stderr: "pipe" });
    const out = (await new Response(proc.stdout).text()).trim();
    expect(await proc.exited).toBe(0);
    expect(out).toBe("True");
  }, 60_000);

  // Runs the same WTS lookup the SYSTEM task uses, as this (unelevated) user, with this user's
  // SID: listing sessions changes nothing, and it proves the C# compiles and the SID matching
  // finds this process's own session.
  it("the session lookup finds this user's own session", async () => {
    // By absolute path, as the service does: Git Bash puts an unrelated `whoami` first on PATH.
    const who = Bun.spawnSync([whoamiExe(), "/user", "/fo", "csv", "/nh"]);
    const sid = parseWhoamiUserCsv(who.stdout.toString());
    if (!sid) return; // a runner signed in with a non-user account has nothing to look up
    const mine = readWindowsSession();
    const probe = `$ErrorActionPreference = 'Stop'
$UserSid = ${psQuote(sid)}
${WTS_SESSION_LOOKUP}
(Get-UserSessions | ForEach-Object { [string]$_.Id + ':' + [string]$_.State }) -join ','`;
    const proc = Bun.spawn(["powershell.exe", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShell(probe)], { stdout: "pipe", stderr: "pipe" });
    const out = (await new Response(proc.stdout).text()).trim();
    expect(await proc.exited).toBe(0);
    const sessions = out.split(",").filter(Boolean).map((s) => s.split(":").map(Number));
    expect(sessions.length).toBeGreaterThan(0);
    if (mine) expect(sessions.map(([id]) => id)).toContain(mine.sessionId);
  }, 60_000);
});
