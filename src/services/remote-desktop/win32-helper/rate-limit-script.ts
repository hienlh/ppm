/**
 * A cap on how often the SYSTEM helper will actually change something, kept on the SYSTEM side.
 *
 * Why here and not in PPM: any process of the PPM user may start the tasks (that is what lets PPM,
 * which never runs elevated, use them), and nothing PPM could hand the task — a ticket, a file
 * in its own folder — is out of reach of another process of that same user. What is out of
 * reach is the helper's own `state` folder under Program Files, so the count lives there.
 *
 * Only real changes count: a refusal, an "already connected", an "already off" or a "kept on" does
 * not. Only the risky direction is capped — moving the session and switching the display off.
 * Turning the display on, `Confirm` and `Rescue` never are: refusing them could leave a session
 * at the console with no screen.
 *
 * Same constraints as `helper-script.ts`: ASCII, no backticks.
 */
import { RATE_LIMITS, RATE_WINDOW_MINUTES } from "./helper-paths.ts";

const GROUPS = Object.keys(RATE_LIMITS).map((g) => `'${g}'`).join(", ");

export const RATE_LIMIT = `
$RateWindowMs = ${RATE_WINDOW_MINUTES} * 60000

function Get-RecentChanges([string]$Group) {
  $log = Read-StateJson 'recent-changes.json'
  $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $cutoff = $now - $RateWindowMs
  if (-not $log -or -not $log.$Group) { return ,@() }
  # Entries from the future (the clock was set back) are dropped, or they would count for ever.
  return ,@($log.$Group | ForEach-Object { [long]$_ } | Where-Object { $_ -ge $cutoff -and $_ -le ($now + 60000) })
}

# @($allowed, $message): the message says what to do instead when it is not allowed.
function Test-ChangeAllowed([string]$Group, [int]$Max, [string]$What) {
  $recent = Get-RecentChanges $Group
  if ($recent.Count -lt $Max) { return @($true, '') }
  return @($false, ('Refused: ' + $What + ' ' + $recent.Count + ' times in the last ${RATE_WINDOW_MINUTES} minutes already. Wait a while, or do it at the PC itself.'))
}

function Add-Change([string]$Group) {
  $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $out = @{}
  foreach ($g in @(${GROUPS})) {
    # Plain assignment, not @(...): the function hands back one array object, and wrapping that
    # in @() again would nest it.
    $kept = Get-RecentChanges $g
    if ($g -eq $Group) { $kept += $now }
    $out[$g] = $kept
  }
  Write-StateFile 'recent-changes.json' ($out | ConvertTo-Json -Compress)
}
`;
