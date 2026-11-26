/**
 * The virtual display parts of the helper's PowerShell: installing the pinned driver (inside
 * `install.ps1`, elevated), removing it (inside `uninstall.ps1`), and the two fixed actions the
 * SYSTEM tasks run (`DisplayOn`, `DisplayOff`).
 *
 * The install refuses anything it did not expect: the zip arrives as bytes the bootstrap already
 * matched to `VDD_ZIP_SHA256`; it is unpacked inside Program Files (where no user can swap a
 * file afterwards), every unpacked file is matched to its own pinned hash, the folder must hold
 * exactly those files, and the catalog and the DLL must carry a Valid signature *from the pinned
 * signer*. Only then is the driver added. The device is left **disabled**.
 *
 * A Virtual Display Driver the user installed before PPM is not taken over: PPM leaves its state
 * as it is and does not remove it on uninstall (`state\vdd.json` records which case it was).
 *
 * Same constraints as `helper-script.ts`: ASCII, no backticks.
 */
import type { HelperActionScript } from "./helper-script.ts";
import { psQuote } from "./powershell-text.ts";
import {
  DISPLAY_CLASS_GUID, VDD_FILES, VDD_HARDWARE_ID, VDD_INF, VDD_SETTINGS_KEY, VDD_SIGNED_FILES,
  VDD_SIGNER_SUBJECT, VDD_VERSION, VDD_ZIP_FOLDER,
} from "./vdd-catalog.ts";

const FIND_DEVICES = `@(Get-PnpDevice -Class Display -ErrorAction SilentlyContinue | Where-Object { $_.HardwareID -contains ${psQuote(VDD_HARDWARE_ID)} })`;

/** SetupAPI's root-device creation, as `devcon install` does it; PowerShell has no cmdlet. */
export const CREATE_DEVICE_TYPE = `
if (-not ('PpmRootDevice' -as [type])) {
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class PpmRootDevice {
  [StructLayout(LayoutKind.Sequential)]
  public struct SP_DEVINFO_DATA { public int cbSize; public Guid ClassGuid; public int DevInst; public IntPtr Reserved; }
  [DllImport("setupapi.dll", SetLastError = true)]
  static extern IntPtr SetupDiCreateDeviceInfoList(ref Guid classGuid, IntPtr hwnd);
  [DllImport("setupapi.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool SetupDiCreateDeviceInfoW(IntPtr set, string name, ref Guid classGuid, string description, IntPtr hwnd, int flags, ref SP_DEVINFO_DATA data);
  [DllImport("setupapi.dll", SetLastError = true)]
  static extern bool SetupDiSetDeviceRegistryPropertyW(IntPtr set, ref SP_DEVINFO_DATA data, int property, byte[] buffer, int size);
  [DllImport("setupapi.dll", SetLastError = true)]
  static extern bool SetupDiCallClassInstaller(int function, IntPtr set, ref SP_DEVINFO_DATA data);
  [DllImport("setupapi.dll", SetLastError = true)]
  static extern bool SetupDiDestroyDeviceInfoList(IntPtr set);
  [DllImport("newdev.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool UpdateDriverForPlugAndPlayDevicesW(IntPtr hwnd, string hardwareId, string infPath, int flags, out bool reboot);
  public static void Create(string hardwareId, string infPath, string className, string classGuid) {
    Guid guid = new Guid(classGuid);
    IntPtr set = SetupDiCreateDeviceInfoList(ref guid, IntPtr.Zero);
    if (set == new IntPtr(-1)) throw new Win32Exception();
    try {
      var data = new SP_DEVINFO_DATA();
      data.cbSize = Marshal.SizeOf(typeof(SP_DEVINFO_DATA));
      if (!SetupDiCreateDeviceInfoW(set, className, ref guid, null, IntPtr.Zero, 1, ref data)) throw new Win32Exception();
      byte[] ids = System.Text.Encoding.Unicode.GetBytes(hardwareId + "\\0\\0");
      if (!SetupDiSetDeviceRegistryPropertyW(set, ref data, 1, ids, ids.Length)) throw new Win32Exception();
      if (!SetupDiCallClassInstaller(0x19, set, ref data)) throw new Win32Exception();
    } finally { SetupDiDestroyDeviceInfoList(set); }
    bool reboot;
    if (!UpdateDriverForPlugAndPlayDevicesW(IntPtr.Zero, hardwareId, infPath, 1, out reboot)) throw new Win32Exception();
  }
}
'@
}
`;

export function buildVddInstallSteps(): string {
  const expected = Object.entries(VDD_FILES).map(([name, sha]) => `${psQuote(name)} = ${psQuote(sha)}`).join("; ");
  const signed = VDD_SIGNED_FILES.map(psQuote).join(", ");
  return `
# --- Virtual display driver ${VDD_VERSION} ---
$Pnputil = Join-Path $env:SystemRoot 'System32\\pnputil.exe'
$VddDir = Join-Path $InstallDir 'vdd'
$VddDriverDir = Join-Path $VddDir ${psQuote(VDD_ZIP_FOLDER)}
$VddSettingsDir = Join-Path $VddDir 'settings'
$VddPreexisting = (${FIND_DEVICES}).Count -gt 0
# A device left by an earlier PPM install (one that stopped part way, say) is PPM's own, not the
# user's: only a device with no record of PPM adding it counts as theirs.
$vddRecordPath = Join-Path $StateDir 'vdd.json'
if ($VddPreexisting -and (Test-Path -LiteralPath $vddRecordPath)) {
  $previous = Get-Content -LiteralPath $vddRecordPath -Raw | ConvertFrom-Json
  if ($previous -and -not $previous.preexisting) { $VddPreexisting = $false }
}

$legacy = Join-Path $env:SystemDrive 'VirtualDisplayDriver'
if (Test-Path -LiteralPath $legacy) {
  $ownerSid = (Get-Acl -LiteralPath $legacy).GetOwner([Security.Principal.SecurityIdentifier]).Value
  if ($ownerSid -ne 'S-1-5-32-544' -and $ownerSid -ne 'S-1-5-18') {
    throw ($legacy + ' exists and is not owned by Administrators; the driver could read settings from it. Remove it and install again.')
  }
}

Assert-NotReparse $VddDir
if (Test-Path -LiteralPath $VddDir) { Remove-Item -LiteralPath $VddDir -Recurse -Force }
New-Item -ItemType Directory -Path $VddDir -Force | Out-Null
$zipPath = Join-Path $VddDir 'vdd.zip'
[IO.File]::WriteAllBytes($zipPath, $VddZipBytes)
Expand-Archive -LiteralPath $zipPath -DestinationPath $VddDir -Force

$expected = @{ ${expected} }
$present = @(Get-ChildItem -LiteralPath $VddDriverDir -Force)
if ($present.Count -ne $expected.Count) { throw 'The driver archive does not hold exactly the expected files.' }
foreach ($name in $expected.Keys) {
  $file = Join-Path $VddDriverDir $name
  Assert-NotReparse $file
  $hash = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($hash -ne $expected[$name]) { throw ('Driver file does not match its pinned hash: ' + $name) }
}
foreach ($name in @(${signed})) {
  $signature = Get-AuthenticodeSignature -LiteralPath (Join-Path $VddDriverDir $name)
  if ($signature.Status -ne 'Valid') { throw ('Driver signature is not valid: ' + $name + ' (' + $signature.Status + ')') }
  if ($signature.SignerCertificate.Subject -ne ${psQuote(VDD_SIGNER_SUBJECT)}) {
    throw ('Driver signed by an unexpected publisher: ' + $signature.SignerCertificate.Subject)
  }
}

New-Item -ItemType Directory -Path $VddSettingsDir -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $VddDriverDir 'vdd_settings.xml') -Destination (Join-Path $VddSettingsDir 'vdd_settings.xml') -Force
if (-not (Test-Path ${psQuote(VDD_SETTINGS_KEY)})) { New-Item -Path ${psQuote(VDD_SETTINGS_KEY)} -Force | Out-Null }
Set-ItemProperty -Path ${psQuote(VDD_SETTINGS_KEY)} -Name 'VDDPATH' -Value $VddSettingsDir

$inf = Join-Path $VddDriverDir ${psQuote(VDD_INF)}
& $Pnputil /add-driver $inf | Out-Null
if (@(0, 259, 3010) -notcontains $LASTEXITCODE) { throw ('pnputil could not add the driver (exit ' + $LASTEXITCODE + ')') }
if (-not $VddPreexisting) {
  if ((${FIND_DEVICES}).Count -eq 0) {
${CREATE_DEVICE_TYPE}
    [PpmRootDevice]::Create(${psQuote(VDD_HARDWARE_ID)}, $inf, 'Display', ${psQuote(DISPLAY_CLASS_GUID)})
  }
  $devices = ${FIND_DEVICES}
  if ($devices.Count -eq 0) { throw 'The virtual display device was not created.' }
  foreach ($device in $devices) { Disable-PnpDevice -InstanceId $device.InstanceId -Confirm:$false }
}
Write-AsciiFile (Join-Path $StateDir 'vdd.json') (@{ version = ${psQuote(VDD_VERSION)}; preexisting = $VddPreexisting } | ConvertTo-Json -Compress)
`;
}

export function buildVddUninstallSteps(): string {
  return `
# --- Virtual display driver: removed only if PPM added it ---
$Pnputil = Join-Path $env:SystemRoot 'System32\\pnputil.exe'
$vddRecord = $null
$vddRecordPath = Join-Path $StateDir 'vdd.json'
if (Test-Path -LiteralPath $vddRecordPath) { $vddRecord = Get-Content -LiteralPath $vddRecordPath -Raw | ConvertFrom-Json }
if ($vddRecord -and -not $vddRecord.preexisting) {
  $infs = @(Get-CimInstance Win32_PnPSignedDriver -ErrorAction SilentlyContinue | Where-Object { $_.HardWareID -eq ${psQuote(VDD_HARDWARE_ID)} } | ForEach-Object { $_.InfName } | Sort-Object -Unique)
  foreach ($device in ${FIND_DEVICES}) { & $Pnputil /remove-device $device.InstanceId | Out-Null }
  foreach ($inf in $infs) { if ($inf -match '^oem[0-9]+[.]inf$') { & $Pnputil /delete-driver $inf /uninstall /force | Out-Null } }
  if (Test-Path ${psQuote(VDD_SETTINGS_KEY)}) { Remove-ItemProperty -Path ${psQuote(VDD_SETTINGS_KEY)} -Name 'VDDPATH' -ErrorAction SilentlyContinue }
}
`;
}

function toggleBody(name: string, cmdlet: "Enable-PnpDevice" | "Disable-PnpDevice", done: string): string {
  return `
function ${name} {
  $devices = ${FIND_DEVICES}
  if ($devices.Count -eq 0) { return @($false, 'The virtual display driver is not installed.') }
  foreach ($device in $devices) { ${cmdlet} -InstanceId $device.InstanceId -Confirm:$false }
  return @($true, ${psQuote(done)})
}
`;
}

export const DISPLAY_ON_ACTION: HelperActionScript = {
  action: "DisplayOn",
  call: "Invoke-DisplayOn",
  body: toggleBody("Invoke-DisplayOn", "Enable-PnpDevice", "The virtual display is on."),
};

export const DISPLAY_OFF_ACTION: HelperActionScript = {
  action: "DisplayOff",
  call: "Invoke-DisplayOff",
  body: toggleBody("Invoke-DisplayOff", "Disable-PnpDevice", "The virtual display is off."),
};
