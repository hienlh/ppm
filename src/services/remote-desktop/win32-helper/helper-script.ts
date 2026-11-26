/**
 * `helper.ps1`: the script the SYSTEM tasks run. Generated once at install time, with the PPM
 * user's SID written into it, then stored under Program Files where only administrators can
 * change it.
 *
 * What it will and will not do:
 * - It takes one parameter, `-Action`, restricted by `ValidateSet` — and each task's command
 *   line fixes that value, so a task cannot be handed anything at all.
 * - `Reattach` moves exactly one session to the console: the single *disconnected* session of
 *   the user whose SID was written in here. Zero or several such sessions → it does nothing and
 *   says why. Sessions are listed through the WTS API, not `quser`, whose output is translated
 *   into the display language.
 * - It writes only inside its own `state` folder, and refuses to write through a reparse point.
 * - Before `Reattach` or `DisplayOn` changes anything it arms the safety net (`rescue-script.ts`).
 * - `DisplayOff` refuses to leave the console session with no screen
 *   (`virtual-display-safety-script.ts`).
 *
 * Plain ASCII, no backticks: Windows PowerShell 5.1 reads a BOM-less file in the system code
 * page, and a backtick would end this TypeScript template.
 */
import { HELPER_VERSION, type HelperAction } from "./helper-paths.ts";
import { isUserSid, psQuote } from "./powershell-text.ts";
import { VIRTUAL_DISPLAY_SAFETY } from "./virtual-display-safety-script.ts";
import { RESCUE_WINDOW } from "./rescue-script.ts";

/** One `switch` branch per action, each calling a function defined in `body`. */
export interface HelperActionScript {
  action: HelperAction;
  /** PowerShell function definitions this action needs; each returns `@($ok, $message)`. */
  body: string;
  /** The expression the branch evaluates, e.g. `Invoke-Reattach`. */
  call: string;
}

/** WTS session listing through C#. `WTS_SESSION_INFOW` is {DWORD id; LPWSTR name; int state}. */
export const WTS_SESSION_LOOKUP = `
if (-not ('PpmWts' -as [type])) {
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class PpmWts {
  [StructLayout(LayoutKind.Sequential)]
  public struct SessionInfo { public int SessionId; public IntPtr WinStationName; public int State; }
  [DllImport("wtsapi32.dll", SetLastError = true)]
  static extern bool WTSEnumerateSessionsW(IntPtr server, int reserved, int version, out IntPtr info, out int count);
  [DllImport("wtsapi32.dll", SetLastError = true)]
  static extern bool WTSQuerySessionInformationW(IntPtr server, int session, int infoClass, out IntPtr buffer, out int bytes);
  [DllImport("wtsapi32.dll")]
  static extern void WTSFreeMemory(IntPtr memory);
  [DllImport("kernel32.dll")]
  static extern int WTSGetActiveConsoleSessionId();
  /** The session at the PC's own screen when someone is signed in to it, else -1 (the sign-in
   *  screen, or no console session at all: the API answers 0xFFFFFFFF). */
  public static int ConsoleUserSession() {
    int id = WTSGetActiveConsoleSessionId();
    if (id < 0) return -1;
    return string.IsNullOrEmpty(Query(id, 5)) ? -1 : id;
  }
  static string Query(int session, int infoClass) {
    IntPtr buffer; int bytes;
    if (!WTSQuerySessionInformationW(IntPtr.Zero, session, infoClass, out buffer, out bytes)) return null;
    try { return Marshal.PtrToStringUni(buffer); } finally { WTSFreeMemory(buffer); }
  }
  public static List<object[]> Sessions() {
    var result = new List<object[]>();
    IntPtr info; int count;
    if (!WTSEnumerateSessionsW(IntPtr.Zero, 0, 1, out info, out count)) throw new System.ComponentModel.Win32Exception();
    try {
      int size = Marshal.SizeOf(typeof(SessionInfo));
      for (int i = 0; i < count; i++) {
        var s = (SessionInfo)Marshal.PtrToStructure(new IntPtr(info.ToInt64() + i * size), typeof(SessionInfo));
        result.Add(new object[] { s.SessionId, s.State, Query(s.SessionId, 7), Query(s.SessionId, 5) });
      }
    } finally { WTSFreeMemory(info); }
    return result;
  }
}
'@
}

function Get-UserSessions {
  $mine = @()
  foreach ($s in [PpmWts]::Sessions()) {
    $domain = [string]$s[2]; $user = [string]$s[3]
    if ([string]::IsNullOrEmpty($user)) { continue }
    try {
      $sid = (New-Object Security.Principal.NTAccount($domain, $user)).Translate([Security.Principal.SecurityIdentifier]).Value
    } catch { continue }
    if ($sid -eq $UserSid) { $mine += [pscustomobject]@{ Id = [int]$s[0]; State = [int]$s[1] } }
  }
  return ,$mine
}
`;

/**
 * Every file the helper writes goes through these: only inside `$StateDir`, never through a
 * reparse point, written to a temporary name and moved into place.
 */
export const STATE_FILES = `
function Assert-NotReparse([string]$Path) {
  if (Test-Path -LiteralPath $Path) {
    $item = Get-Item -LiteralPath $Path -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw ('refusing to write through a reparse point: ' + $Path) }
  }
}

function Write-StateFile([string]$Name, [string]$Text) {
  Assert-NotReparse $StateDir
  $target = Join-Path $StateDir $Name
  $tmp = $target + '.tmp'
  Assert-NotReparse $target; Assert-NotReparse $tmp
  [IO.File]::WriteAllText($tmp, $Text, (New-Object Text.UTF8Encoding($false)))
  Move-Item -LiteralPath $tmp -Destination $target -Force
}

function Read-StateJson([string]$Name) {
  $path = Join-Path $StateDir $Name
  if (-not (Test-Path -LiteralPath $path)) { return $null }
  try { return (Get-Content -LiteralPath $path -Raw | ConvertFrom-Json) } catch { return $null }
}

function Remove-StateFile([string]$Name) {
  Assert-NotReparse $StateDir
  $path = Join-Path $StateDir $Name
  Assert-NotReparse $path
  if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force }
}
`;

export const REATTACH_ACTION: HelperActionScript = {
  action: "Reattach",
  call: "Invoke-Reattach",
  body: `
function Invoke-Tscon([int]$Id) {
  $tscon = Join-Path $env:SystemRoot 'System32\\tscon.exe'
  if (-not (Test-Path -LiteralPath $tscon)) { return -1 }
  & $tscon $Id /dest:console | Out-Null
  return $LASTEXITCODE
}

function Invoke-Reattach {
  $mine = Get-UserSessions
  $disconnected = @($mine | Where-Object { $_.State -eq 4 })
  if ($disconnected.Count -eq 0) {
    if ($mine.Count -gt 0) { return @($true, 'The session is already connected.') }
    return @($false, 'No Windows session of the PPM user was found.')
  }
  if ($disconnected.Count -gt 1) { return @($false, 'The PPM user has more than one disconnected session; not choosing one.') }
  $id = $disconnected[0].Id
  # The safety net goes up before the session moves: if it cannot, the session stays where it is.
  Start-RescueWindow 'Reattach'
  $code = Invoke-Tscon $id
  if ($code -ne 0) {
    Stop-RescueWindow
    if ($code -eq -1) { return @($false, 'tscon.exe is not available on this edition of Windows.') }
    return @($false, ('tscon failed with exit code ' + $code + ' for session ' + $id + '.'))
  }
  return @($true, ('Session ' + $id + ' is back on the PC screen.'))
}
`,
};

export function buildHelperScript(userSid: string, actions: HelperActionScript[]): string {
  if (!isUserSid(userSid)) throw new Error("refusing to build the helper for a non-user SID");
  const names = actions.map((a) => psQuote(a.action)).join(", ");
  const branches = actions.map((a) => `    ${psQuote(a.action)} { $r = ${a.call} }`).join("\n");
  return `# PPM Remote Desktop helper v${HELPER_VERSION}. Generated by PPM; run as SYSTEM by Task Scheduler.
# Each task passes one fixed -Action. Only the user below is ever acted on.
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet(${names})]
  [string]$Action
)
$ErrorActionPreference = 'Stop'
$UserSid = ${psQuote(userSid)}
$StateDir = Join-Path $PSScriptRoot 'state'

${STATE_FILES}
function Write-HelperState([bool]$Ok, [string]$Message) {
  $at = [DateTime]::UtcNow.ToString('o')
  Write-StateFile 'last-run.json' (@{ action = $Action; ok = $Ok; message = $Message; at = $at; version = ${HELPER_VERSION} } | ConvertTo-Json -Compress)
  $log = Join-Path $StateDir 'helper.log'
  Assert-NotReparse $log
  if ((Test-Path -LiteralPath $log) -and ((Get-Item -LiteralPath $log).Length -gt 262144)) { Remove-Item -LiteralPath $log -Force }
  Add-Content -LiteralPath $log -Value ($at + ' ' + $Action + ' ok=' + $Ok + ' ' + $Message) -Encoding UTF8
}
${WTS_SESSION_LOOKUP}
${VIRTUAL_DISPLAY_SAFETY}
${RESCUE_WINDOW}
${actions.map((a) => a.body).join("\n")}
try {
  switch ($Action) {
${branches}
  }
  Write-HelperState ([bool]$r[0]) ([string]$r[1])
  if (-not $r[0]) { exit 1 }
  exit 0
} catch {
  try { Write-HelperState $false ('Helper error: ' + $_.Exception.Message) } catch { }
  exit 2
}
`;
}
