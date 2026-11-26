/**
 * The safety net behind `Reattach` and `DisplayOn`: if nobody confirms within `RESCUE_MINUTES`
 * that the PC can still be reached, a SYSTEM task puts the one thing it safely can back in place.
 *
 * How it is built (chosen over a task that wakes every minute, which would run a SYSTEM
 * PowerShell forever for a window that is open five minutes after a click):
 * - The `Rescue` task is installed with no trigger at all.
 * - Before `Reattach` or `DisplayOn` changes anything, the helper records `state\rescue.json` and
 *   gives `Rescue` a one-time trigger at now + N minutes (`StartWhenAvailable`, so a PC that was
 *   asleep runs it on waking). If the trigger cannot be set, the action does not run.
 * - "I can still reach this PC" in PPM runs `Confirm`, which first does what `Rescue` would (reaching
 *   PPM proves nothing about the console's screen), then removes the trigger and the record.
 * - When `Rescue` fires with the record still there, it turns the virtual display on if someone is
 *   signed in at the console and the PC has no monitor of its own (the state that locked a PC
 *   out), then removes the trigger and the record. It never signs anyone out and never moves a
 *   session: signing out loses the user's running work, and moving the session is the very step
 *   under suspicion.
 *
 * The trigger is edited through the Task Scheduler COM API from inside the SYSTEM task, keeping
 * the task's own security descriptor (read back with `GetSecurityDescriptor`), so editing it can
 * never widen who may run it.
 *
 * Its reach is honest about time: it helps with a lock-out that shows within those minutes.
 * One that shows hours later is what `DisplayOff`'s own refusal is for.
 *
 * Same constraints as `helper-script.ts`: ASCII, no backticks.
 */
import type { HelperActionScript } from "./helper-script.ts";
import { RESCUE_MINUTES, TASK_FOLDER_NAME } from "./helper-paths.ts";
import { FIND_DEVICES } from "./virtual-display-safety-script.ts";

/** Arming and disarming; every action that changes something calls these. */
export const RESCUE_WINDOW = `
$RescueMinutes = ${RESCUE_MINUTES}

function Update-RescueTask([scriptblock]$Change) {
  $service = New-Object -ComObject Schedule.Service
  $service.Connect()
  $folder = $service.GetFolder('\\${TASK_FOLDER_NAME}')
  $task = $folder.GetTask('Rescue')
  $definition = $task.Definition
  & $Change $definition
  # 4 = DACL: the task keeps exactly who may read and run it.
  $sddl = $task.GetSecurityDescriptor(4)
  # 4 = TASK_UPDATE, 5 = TASK_LOGON_SERVICE_ACCOUNT.
  $null = $folder.RegisterTaskDefinition('Rescue', $definition, 4, 'S-1-5-18', $null, 5, $sddl)
}

function Set-RescueTrigger([DateTime]$At) {
  $start = $At.ToString('s')
  Update-RescueTask ({
    param($definition)
    $definition.Triggers.Clear()
    $trigger = $definition.Triggers.Create(1)
    $trigger.StartBoundary = $start
    $definition.Settings.StartWhenAvailable = $true
  }.GetNewClosure())
}

function Clear-RescueTrigger { Update-RescueTask { param($definition) $definition.Triggers.Clear() } }

function Start-RescueWindow([string]$For) {
  $now = [DateTimeOffset]::Now
  $deadline = $now.AddMinutes($RescueMinutes)
  Set-RescueTrigger $deadline.LocalDateTime
  Write-StateFile 'rescue.json' (@{ action = $For; armedMs = $now.ToUnixTimeMilliseconds(); deadlineMs = $deadline.ToUnixTimeMilliseconds() } | ConvertTo-Json -Compress)
}

function Stop-RescueWindow {
  Clear-RescueTrigger
  Remove-StateFile 'rescue.json'
}

# What Confirm and Rescue both do before taking the net down: a session signed in at a PC with no
# monitor of its own gets the virtual display. Turning it on is never capped.
function Set-ConsoleScreen {
  if (-not (Test-VirtualDisplayNeeded)) { return 'The session at this PC has a screen.' }
  $devices = ${FIND_DEVICES}
  if ($devices.Count -eq 0) { return 'No virtual display driver to turn on.' }
  foreach ($device in $devices) { Enable-PnpDevice -InstanceId $device.InstanceId -Confirm:$false }
  return 'Turned the virtual display on for the session at this PC.'
}
`;

export const CONFIRM_ACTION: HelperActionScript = {
  action: "Confirm",
  call: "Invoke-Confirm",
  body: `
# Reaching PPM says nothing about the console's screen: a session moved to the console of a PC
# with no monitor and the display off still serves PPM. So confirming first does what the net
# would have done, then takes the net down.
function Invoke-Confirm {
  $armed = Read-StateJson 'rescue.json'
  $what = Set-ConsoleScreen
  Stop-RescueWindow
  if (-not $armed) { return @($true, ('Nothing was waiting for confirmation. ' + $what)) }
  return @($true, ('Confirmed. The safety net for ' + $armed.action + ' is off. ' + $what))
}
`,
};

export const RESCUE_ACTION: HelperActionScript = {
  action: "Rescue",
  call: "Invoke-Rescue",
  body: `
function Invoke-Rescue {
  $armed = Read-StateJson 'rescue.json'
  if (-not $armed) {
    Clear-RescueTrigger
    return @($true, 'Nothing was waiting: the last change was confirmed.')
  }
  # A run before the deadline (a clock change, an administrator starting it by hand) does nothing.
  if ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -lt ([long]$armed.deadlineMs - 30000)) {
    return @($true, 'Not due yet.')
  }
  $what = Set-ConsoleScreen
  Stop-RescueWindow
  return @($true, ('Safety net ran: ' + $armed.action + ' was not confirmed in time. ' + $what))
}
`,
};
