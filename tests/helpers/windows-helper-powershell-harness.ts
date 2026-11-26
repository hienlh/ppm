/**
 * Runs pieces of the generated SYSTEM helper script in the real Windows PowerShell 5.1 (the one
 * the tasks use), with every Windows call it makes replaced by a stand-in.
 *
 * PowerShell resolves a function before a cmdlet of the same name, and a later function
 * definition replaces an earlier one, so the fakes below are appended after the helper's own
 * functions: `Get-PnpDevice`, `Enable/Disable-PnpDevice`, the console session, tscon and the
 * Task Scheduler calls all land here. Nothing reaches a device, a session or a task.
 *
 * Each scenario sets `$global:` state before calling an action and gets back what the action
 * answered, every call it made (`calls`), and the state folder's files.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const WINDOWS_FAKES = `
$global:Calls = New-Object System.Collections.ArrayList
function Add-Call([string]$What) { [void]$global:Calls.Add($What) }
$global:ConsoleSession = -1
$global:Monitors = @()
$global:VirtualDevices = @([pscustomobject]@{ InstanceId = 'ROOT\\DISPLAY\\0000'; HardwareID = @('Root\\MttVDD') })
$global:UserSessions = @()
$global:TsconExit = 0
$global:TriggerFails = $false
$global:TriggerAt = $null

function Get-PnpDevice {
  [CmdletBinding()] param([string]$Class, [switch]$PresentOnly)
  if ($Class -eq 'Display') { return $global:VirtualDevices }
  if ($Class -eq 'Monitor') { return @($global:Monitors | ForEach-Object { [pscustomobject]@{ InstanceId = $_.Id } }) }
  throw ('unexpected device class ' + $Class)
}
function Get-PnpDeviceProperty {
  [CmdletBinding()] param([string]$InstanceId, [string]$KeyName)
  $m = @($global:Monitors | Where-Object { $_.Id -eq $InstanceId })[0]
  return [pscustomobject]@{ Data = $m.Parent }
}
function Enable-PnpDevice { [CmdletBinding(SupportsShouldProcess = $true)] param([string]$InstanceId) Add-Call ('enable ' + $InstanceId) }
function Disable-PnpDevice { [CmdletBinding(SupportsShouldProcess = $true)] param([string]$InstanceId) Add-Call ('disable ' + $InstanceId) }
function Get-ConsoleUserSession { return $global:ConsoleSession }
function Get-UserSessions { return ,@($global:UserSessions) }
function Invoke-Tscon([int]$Id) { Add-Call ('tscon ' + $Id); return $global:TsconExit }
function Set-RescueTrigger([DateTime]$At) {
  if ($global:TriggerFails) { throw 'Task Scheduler refused the trigger' }
  $global:TriggerAt = $At
  Add-Call 'arm-trigger'
}
function Clear-RescueTrigger { Add-Call 'clear-trigger' }
`;

export interface ScenarioResult {
  ok: boolean;
  message: string;
  calls: string[];
  /** When the safety net's trigger was set for, if it was. */
  triggerMs: number | null;
  /** Each file in the state folder after the run, by name. */
  state: Record<string, string>;
}

/**
 * `pieces`: the helper's own PowerShell (function definitions). `setup`: assignments to the
 * fakes' `$global:` state. `call`: the expression whose `@($ok, $message)` is reported.
 * `stateFiles`: files to put in the state folder first.
 */
export async function runHelperScenario(opts: {
  pieces: string[];
  setup?: string;
  call: string;
  stateFiles?: Record<string, string>;
}): Promise<ScenarioResult> {
  const dir = mkdtempSync(join(tmpdir(), "ppm-helper-scenario-"));
  const stateDir = join(dir, "state");
  try {
    mkdirSync(stateDir);
    for (const [name, text] of Object.entries(opts.stateFiles ?? {})) writeFileSync(join(stateDir, name), text);
    const script = `$ErrorActionPreference = 'Stop'
$StateDir = '${stateDir.replace(/'/g, "''")}'
${opts.pieces.join("\n")}
${WINDOWS_FAKES}
${opts.setup ?? ""}
try { $r = ${opts.call} } catch { $r = @($false, ('threw: ' + $_.Exception.Message)) }
$triggerMs = $null
if ($global:TriggerAt) { $triggerMs = ([DateTimeOffset]$global:TriggerAt).ToUnixTimeMilliseconds() }
@{ ok = [bool]$r[0]; message = [string]$r[1]; calls = @($global:Calls); triggerMs = $triggerMs } | ConvertTo-Json -Compress
`;
    const file = join(dir, "scenario.ps1");
    writeFileSync(file, script);
    const proc = Bun.spawn(
      ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (code !== 0) throw new Error(`scenario failed (exit ${code}): ${err.trim() || out.trim()}`);
    const parsed = JSON.parse(out.trim().split(/\r?\n/).at(-1)!) as Omit<ScenarioResult, "state">;
    const state: Record<string, string> = {};
    for (const name of readdirSync(stateDir)) state[name] = readFileSync(join(stateDir, name), "utf8");
    return { ...parsed, calls: parsed.calls ?? [], state };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
