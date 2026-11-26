/**
 * The one rule the virtual display must never break: a session signed in at the PC's own screen
 * is never left with no display at all.
 *
 * Found the hard way on a headless Windows 11 host: the session was brought to the console, the
 * virtual display was turned on and off a few times, and the last "off" left that session on
 * `WinDisc` — no output of any kind, not even the GPU's own 1024x768 fallback, which never came
 * back for it. Seven hours later an RDP reconnect into that session hung before Windows could
 * attach its RDP display, and every sign-in after that queued behind it until the PC was powered
 * off. So turning the display off is refused whenever it is the only one the console has.
 *
 * Checked here, in the SYSTEM script, rather than in PPM: a `schtasks /run` of DisplayOff typed
 * by hand is refused just the same.
 *
 * Two questions, each a function of its own so the behaviour tests can stand in for Windows:
 * - Is anyone signed in at the console? Any user, not only PPM's.
 * - Does the PC have a monitor of its own? A present Monitor-class device whose parent is real
 *   hardware. Measured on that host: a physical monitor hangs off `PCI\VEN_10DE...` (the GPU),
 *   the virtual one off `ROOT\DISPLAY\0000` (its own device), RDP's off
 *   `SWD\RemoteDisplayEnum\...` and TeamViewer's off `SWD\TVVirtualMonitor...`. A parent that
 *   cannot be read counts as no monitor: when unsure, the display stays on.
 *
 * Same constraints as `helper-script.ts`: ASCII, no backticks.
 */
import { psQuote } from "./powershell-text.ts";
import { VDD_HARDWARE_ID } from "./vdd-catalog.ts";

/** The virtual display's own device(s), by the pinned hardware id. */
export const FIND_DEVICES = `@(Get-PnpDevice -Class Display -ErrorAction SilentlyContinue | Where-Object { $_.HardwareID -contains ${psQuote(VDD_HARDWARE_ID)} })`;

export const VIRTUAL_DISPLAY_SAFETY = `
function Get-ConsoleUserSession { return [PpmWts]::ConsoleUserSession() }

function Get-HardwareMonitorCount {
  $virtual = @(${FIND_DEVICES} | ForEach-Object { ([string]$_.InstanceId).ToUpperInvariant() })
  $count = 0
  foreach ($monitor in @(Get-PnpDevice -Class Monitor -PresentOnly -ErrorAction SilentlyContinue)) {
    $parent = [string](Get-PnpDeviceProperty -InstanceId $monitor.InstanceId -KeyName 'DEVPKEY_Device_Parent' -ErrorAction SilentlyContinue).Data
    if ([string]::IsNullOrEmpty($parent)) { continue }
    $parent = $parent.ToUpperInvariant()
    if ($parent.StartsWith('SWD\\') -or ($virtual -contains $parent)) { continue }
    $count++
  }
  return $count
}

# True when turning the virtual display off would leave the session at the console with no screen.
function Test-VirtualDisplayNeeded {
  if ((Get-ConsoleUserSession) -lt 0) { return $false }
  return ((Get-HardwareMonitorCount) -eq 0)
}
`;

/** What `DisplayOff` answers when it refuses. PPM keeps its marker and tries again later. */
export const KEPT_ON_MESSAGE = "Kept on: someone is signed in at this PC's screen and the PC has no monitor of its own, "
  + "so turning the virtual display off would leave that session with no screen at all.";
