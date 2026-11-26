/**
 * The administrator side of the helper: `install.ps1`, `uninstall.ps1`, and the tiny bootstrap
 * that `-EncodedCommand` carries into the elevated PowerShell.
 *
 * Why a bootstrap and not the whole script on the command line: the helper plus the installer
 * would exceed the 32,767-character command line. So PPM stages the payloads in its own folder
 * (which the user can write to) and the bootstrap carries only their SHA-256. It reads each file
 * into memory **once**, checks the hash of those very bytes, and from then on uses only them —
 * swapping a staged file after PPM wrote it gets the install refused, never run.
 *
 * Exit codes the bootstrap uses (read by `helper-service.ts`):
 *   0 done · 10 a staged payload did not match its hash · 20 the install itself failed (its
 *   message is in `state\install-result.json` when the state folder exists).
 */
import { HELPER_VERSION, type HelperAction } from "./helper-paths.ts";
import { isUserSid, psQuote } from "./powershell-text.ts";

export const EXIT_OK = 0;
export const EXIT_PAYLOAD_CHANGED = 10;
export const EXIT_INSTALL_FAILED = 20;
/** Not the bootstrap's: the unelevated launcher's, when `Start-Process -Verb RunAs` threw
 *  (the prompt was declined, or there was nobody to show it to). Same number as Windows'
 *  ERROR_CANCELLED so it reads the same in logs. */
export const EXIT_ELEVATION_REFUSED = 1223;

/** Shared prelude: the install folder and how it is locked down. Group SIDs, never names —
 *  "Administrators" is "Quản trị viên" on a Vietnamese Windows. */
const PRELUDE = `
$ErrorActionPreference = 'Stop'
$InstallDir = Join-Path $env:ProgramFiles 'PPM\\RemoteDesktopHelper'
$StateDir = Join-Path $InstallDir 'state'
$PowerShellExe = Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'
$Icacls = Join-Path $env:SystemRoot 'System32\\icacls.exe'
$TaskPath = '\\PPM\\RemoteDesktop\\'

function Assert-NotReparse([string]$Path) {
  if (Test-Path -LiteralPath $Path) {
    $item = Get-Item -LiteralPath $Path -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw ('refusing: ' + $Path + ' is a reparse point') }
  }
}

function Protect-HelperDir([string]$Path) {
  Assert-NotReparse $Path
  if (-not (Test-Path -LiteralPath $Path)) { New-Item -ItemType Directory -Path $Path -Force | Out-Null }
  & $Icacls $Path /setowner '*S-1-5-32-544' /T /C /Q | Out-Null
  & $Icacls $Path /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-32-545:(OI)(CI)RX' /T /C /Q | Out-Null
  if ($LASTEXITCODE -ne 0) { throw ('icacls failed on ' + $Path) }
}

function Write-AsciiFile([string]$Path, [string]$Text) {
  Assert-NotReparse $Path
  [IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding($false)))
}
`;

export interface InstallScriptOptions {
  userSid: string;
  actions: HelperAction[];
  /** Extra admin-side steps (the virtual display driver), run after the folder exists and
   *  before the tasks are registered. Each reads only variables the bootstrap set. */
  extraSteps?: string;
}

export function buildInstallScript(opts: InstallScriptOptions): string {
  if (!isUserSid(opts.userSid)) throw new Error("refusing to install for a non-user SID");
  const actions = opts.actions.map(psQuote).join(", ");
  // Read + execute for the PPM user only. No other user can start these tasks, and no
  // ordinary user can change or delete them.
  const taskSddl = `D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;GRGX;;;${opts.userSid})`;
  return `# PPM Remote Desktop helper installer v${HELPER_VERSION}. Runs elevated, from bytes the bootstrap verified.
${PRELUDE}
$UserSid = ${psQuote(opts.userSid)}
Protect-HelperDir $InstallDir
if (-not (Test-Path -LiteralPath $StateDir)) { New-Item -ItemType Directory -Path $StateDir -Force | Out-Null }
Protect-HelperDir $InstallDir
$HelperPath = Join-Path $InstallDir 'helper.ps1'
Assert-NotReparse $HelperPath
[IO.File]::WriteAllBytes($HelperPath, $HelperBytes)
${opts.extraSteps ?? ""}
$service = New-Object -ComObject Schedule.Service
$service.Connect()
# Register-ScheduledTask does not create a nested folder whose parent is missing (it fails with
# "The system cannot find the path specified"), so each level is made here first.
$folder = $service.GetFolder('\\')
foreach ($segment in @('PPM', 'RemoteDesktop')) {
  try { $folder = $folder.GetFolder($segment) } catch { $folder = $folder.CreateFolder($segment) }
}
foreach ($action in @(${actions})) {
  $argument = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $HelperPath + '" -Action ' + $action
  $taskAction = New-ScheduledTaskAction -Execute $PowerShellExe -Argument $argument
  $principal = New-ScheduledTaskPrincipal -UserId 'S-1-5-18' -LogonType ServiceAccount -RunLevel Highest
  $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 2) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  Register-ScheduledTask -TaskName $action -TaskPath $TaskPath -Action $taskAction -Principal $principal -Settings $settings -Force | Out-Null
  $service.GetFolder($TaskPath.TrimEnd('\\')).GetTask($action).SetSecurityDescriptor(${psQuote(taskSddl)}, 0)
}
$record = @{ version = ${HELPER_VERSION}; userSid = $UserSid; actions = @(${actions}); installedAt = [DateTime]::UtcNow.ToString('o') } | ConvertTo-Json -Compress
Write-AsciiFile (Join-Path $StateDir 'install.json') $record
Write-AsciiFile (Join-Path $StateDir 'install-result.json') (@{ ok = $true; message = 'Installed.'; at = [DateTime]::UtcNow.ToString('o') } | ConvertTo-Json -Compress)
`;
}

export interface UninstallScriptOptions {
  actions: HelperAction[];
  /** Extra admin-side removal steps (the virtual display driver), run before the folder goes. */
  extraSteps?: string;
}

export function buildUninstallScript(opts: UninstallScriptOptions): string {
  const actions = opts.actions.map(psQuote).join(", ");
  return `# PPM Remote Desktop helper uninstaller v${HELPER_VERSION}.
${PRELUDE}
foreach ($action in @(${actions})) {
  Unregister-ScheduledTask -TaskName $action -TaskPath $TaskPath -Confirm:$false -ErrorAction SilentlyContinue
}
${opts.extraSteps ?? ""}
try {
  $service = New-Object -ComObject Schedule.Service
  $service.Connect()
  $service.GetFolder('\\PPM').DeleteFolder('RemoteDesktop', 0)
  $service.GetFolder('\\').DeleteFolder('PPM', 0)
} catch { }
Assert-NotReparse $InstallDir
if (Test-Path -LiteralPath $InstallDir) { Remove-Item -LiteralPath $InstallDir -Recurse -Force }
`;
}

export interface StagedPayload {
  /** The PowerShell variable the verified bytes land in, e.g. `HelperBytes`. */
  variable: string;
  path: string;
  sha256: string;
}

/**
 * The script `-EncodedCommand` carries. `scriptPayload` is the installer or uninstaller; it is
 * run from the bytes just verified, never from the file again.
 */
export function buildBootstrap(payloads: StagedPayload[], scriptPayload: StagedPayload): string {
  const reads = [...payloads, scriptPayload].map((p) => {
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(p.variable)) throw new Error(`bad payload variable ${p.variable}`);
    if (!/^[0-9a-f]{64}$/.test(p.sha256)) throw new Error(`bad sha256 for ${p.variable}`);
    return `  $${p.variable} = Read-Verified ${psQuote(p.path)} ${psQuote(p.sha256)}`;
  }).join("\n");
  return `$ErrorActionPreference = 'Stop'
function Read-Verified([string]$Path, [string]$Expected) {
  $bytes = [IO.File]::ReadAllBytes($Path)
  $sha = [Security.Cryptography.SHA256]::Create()
  $actual = ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
  if ($actual -ne $Expected) { throw 'payload changed' }
  return ,$bytes
}
try {
${reads}
} catch { exit ${EXIT_PAYLOAD_CHANGED} }
try {
  . ([ScriptBlock]::Create((New-Object Text.UTF8Encoding($false)).GetString($${scriptPayload.variable})))
  exit ${EXIT_OK}
} catch {
  # Which line failed, so a report from the field names the step and not only Windows' sentence.
  $message = $_.Exception.Message.Trim() + ' (line ' + $_.InvocationInfo.ScriptLineNumber + ': ' + ([string]$_.InvocationInfo.Line).Trim() + ')'
  try {
    $state = Join-Path $env:ProgramFiles 'PPM\\RemoteDesktopHelper\\state'
    $target = Join-Path $state 'install-result.json'
    $isLink = (Test-Path -LiteralPath $target) -and ((Get-Item -LiteralPath $target -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)
    if ((Test-Path -LiteralPath $state) -and -not $isLink) {
      $json = @{ ok = $false; message = $message; at = [DateTime]::UtcNow.ToString('o') } | ConvertTo-Json -Compress
      [IO.File]::WriteAllText($target, $json, (New-Object Text.UTF8Encoding($false)))
    }
  } catch { }
  exit ${EXIT_INSTALL_FAILED}
}
`;
}

/** The unelevated launcher: asks for elevation and waits, so PPM gets the bootstrap's exit
 *  code. A declined (or unshowable) prompt makes `Start-Process` throw. */
export function buildElevationLauncher(powershellExe: string, encodedBootstrap: string): string {
  if (!/^[A-Za-z0-9+/=]+$/.test(encodedBootstrap)) throw new Error("bootstrap must be base64");
  const args = `-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encodedBootstrap}`;
  return `try {
  $p = Start-Process -FilePath ${psQuote(powershellExe)} -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ArgumentList ${psQuote(args)}
  exit $p.ExitCode
} catch { exit ${EXIT_ELEVATION_REFUSED} }
`;
}
