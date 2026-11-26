import { describe, expect, it } from "bun:test";
import {
  VDD_FILES, VDD_SIGNED_FILES, VDD_SIGNER_SUBJECT, VDD_ZIP_SHA256, VDD_ZIP_URL, VDD_VERSION,
} from "../../../../src/services/remote-desktop/win32-helper/vdd-catalog.ts";
import {
  buildVddInstallSteps, buildVddUninstallSteps, DISPLAY_OFF_ACTION, DISPLAY_ON_ACTION,
} from "../../../../src/services/remote-desktop/win32-helper/vdd-scripts.ts";
import { isAscii } from "../../../../src/services/remote-desktop/win32-helper/powershell-text.ts";
import {
  GRACE_MS, IDLE_MS, VirtualDisplayLease, type LeaseDeps,
} from "../../../../src/services/remote-desktop/win32-helper/virtual-display-lease.ts";

describe("pinned driver", () => {
  it("pins one release by URL, zip hash and every file's hash", () => {
    expect(VDD_ZIP_URL).toContain(`/download/${VDD_VERSION}/`);
    expect(VDD_ZIP_SHA256).toMatch(/^[0-9a-f]{64}$/);
    for (const sha of Object.values(VDD_FILES)) expect(sha).toMatch(/^[0-9a-f]{64}$/);
    for (const name of VDD_SIGNED_FILES) expect(Object.keys(VDD_FILES)).toContain(name);
    expect(VDD_SIGNER_SUBJECT).toStartWith("CN=SignPath Foundation,");
  });
});

describe("driver install steps", () => {
  const steps = buildVddInstallSteps();

  it("checks every file's hash, the exact file set, and the signer before adding the driver", () => {
    const check = steps.indexOf("Get-AuthenticodeSignature");
    const add = steps.indexOf("/add-driver");
    expect(check).toBeGreaterThan(0);
    expect(add).toBeGreaterThan(check);
    expect(steps.indexOf("Get-FileHash")).toBeLessThan(add);
    expect(steps).toContain("$present.Count -ne $expected.Count");
    expect(steps).toContain("$signature.Status -ne 'Valid'");
    expect(steps).toContain(`$signature.SignerCertificate.Subject -ne '${VDD_SIGNER_SUBJECT}'`);
    for (const [name, sha] of Object.entries(VDD_FILES)) expect(steps).toContain(`'${name}' = '${sha}'`);
  });

  it("unpacks only inside Program Files, from the bytes the bootstrap verified", () => {
    expect(steps).toContain("$VddDir = Join-Path $InstallDir 'vdd'");
    expect(steps).toContain("[IO.File]::WriteAllBytes($zipPath, $VddZipBytes)");
    expect(steps).not.toMatch(/\$env:TEMP|GetTempPath/);
  });

  it("points the driver's settings into Program Files and refuses a user-owned C:\\VirtualDisplayDriver", () => {
    expect(steps).toContain("-Name 'VDDPATH' -Value $VddSettingsDir");
    expect(steps).toContain("GetOwner([Security.Principal.SecurityIdentifier])");
    expect(steps).toContain("$ownerSid -ne 'S-1-5-32-544' -and $ownerSid -ne 'S-1-5-18'");
  });

  it("leaves a new device disabled, and leaves a driver the user already had alone", () => {
    expect(steps).toContain("Disable-PnpDevice -InstanceId $device.InstanceId");
    expect(steps).toContain("if (-not $VddPreexisting) {");
    expect(steps).toContain("preexisting = $VddPreexisting");
  });

  it("a device an earlier PPM install left is PPM's own, and is not created twice", () => {
    expect(steps).toContain("if ($previous -and -not $previous.preexisting) { $VddPreexisting = $false }");
    expect(steps).toMatch(/if \(\(@\(Get-PnpDevice[^\n]*\)\)\.Count -eq 0\) \{\n[\s\S]*\[PpmRootDevice\]::Create/);
  });

  it("uninstall removes only a driver PPM added", () => {
    const un = buildVddUninstallSteps();
    expect(un).toContain("if ($vddRecord -and -not $vddRecord.preexisting)");
    expect(un).toContain("/delete-driver $inf /uninstall /force");
    expect(un).toContain("'^oem[0-9]+[.]inf$'");
  });

  it("is ASCII with no backtick", () => {
    for (const text of [steps, buildVddUninstallSteps(), DISPLAY_ON_ACTION.body, DISPLAY_OFF_ACTION.body]) {
      expect(isAscii(text)).toBe(true);
      expect(text).not.toContain("`");
    }
  });

  it("the on/off actions touch only the pinned hardware id", () => {
    expect(DISPLAY_ON_ACTION.body).toContain("-contains 'Root\\MttVDD'");
    expect(DISPLAY_ON_ACTION.body).toContain("Enable-PnpDevice");
    expect(DISPLAY_OFF_ACTION.body).toContain("Disable-PnpDevice");
  });
});

/** A lease with a hand-cranked clock: timers run only when the test says so. */
function harness(markerInitially = false) {
  let marker = markerInitially;
  const runs: string[] = [];
  const timers: Array<{ fn: () => void; ms: number; live: boolean }> = [];
  const deps: LeaseDeps = {
    run: async (action) => { runs.push(action); return { ok: true, message: "" }; },
    readMarker: () => marker,
    writeMarker: (on) => { marker = on; },
    setTimer: (fn, ms) => { const t = { fn, ms, live: true }; timers.push(t); return t; },
    clearTimer: (h) => { (h as { live: boolean }).live = false; },
  };
  const fire = async () => {
    for (const t of timers.filter((x) => x.live)) { t.live = false; t.fn(); }
    await Promise.resolve(); await Promise.resolve();
  };
  return { lease: new VirtualDisplayLease(deps), runs, timers, fire, marker: () => marker };
}

describe("virtual display lease", () => {
  it("turned on with no session following → off after the idle wait", async () => {
    const h = harness();
    await h.lease.turnOn();
    expect(h.timers.at(-1)!.ms).toBe(IDLE_MS);
    await h.fire();
    expect(h.runs).toEqual(["DisplayOn", "DisplayOff"]);
    expect(h.marker()).toBe(false);
  });

  it("stays on while any session runs, and goes off a grace period after the last one ends", async () => {
    const h = harness();
    await h.lease.turnOn();
    h.lease.acquire();
    h.lease.acquire();
    expect(h.timers.every((t) => !t.live)).toBe(true);
    h.lease.release();
    await h.fire();
    expect(h.runs).toEqual(["DisplayOn"]);
    h.lease.release();
    expect(h.timers.at(-1)!.ms).toBe(GRACE_MS);
    await h.fire();
    expect(h.runs).toEqual(["DisplayOn", "DisplayOff"]);
  });

  it("a session starting during the grace period keeps it on", async () => {
    const h = harness();
    await h.lease.turnOn();
    h.lease.acquire();
    h.lease.release();
    h.lease.acquire();
    await h.fire();
    expect(h.runs).toEqual(["DisplayOn"]);
  });

  it("never turns off a display PPM did not turn on", async () => {
    const h = harness(false);
    h.lease.acquire();
    h.lease.release();
    await h.fire();
    await h.lease.sweepOnStartup();
    expect(h.runs).toEqual([]);
  });

  it("turns off at startup a display a previous run left on", async () => {
    const h = harness(true);
    await h.lease.sweepOnStartup();
    expect(h.runs).toEqual(["DisplayOff"]);
    expect(h.marker()).toBe(false);
  });
});
