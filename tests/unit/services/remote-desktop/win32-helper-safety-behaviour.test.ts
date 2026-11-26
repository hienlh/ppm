/**
 * What the SYSTEM helper actually does, run in Windows PowerShell 5.1 with every Windows call
 * replaced (`tests/helpers/windows-helper-powershell-harness.ts`). Windows only: that is where
 * PowerShell 5.1 is.
 */
import { describe, expect, it } from "bun:test";
import { runHelperScenario } from "../../../helpers/windows-helper-powershell-harness.ts";
import { VIRTUAL_DISPLAY_SAFETY } from "../../../../src/services/remote-desktop/win32-helper/virtual-display-safety-script.ts";
import { DISPLAY_OFF_ACTION, DISPLAY_ON_ACTION } from "../../../../src/services/remote-desktop/win32-helper/vdd-scripts.ts";

const DISPLAY = [VIRTUAL_DISPLAY_SAFETY, DISPLAY_ON_ACTION.body, DISPLAY_OFF_ACTION.body];
const T = 60_000;

/** Monitors as Windows reported them on a real headless host (instance id → parent). */
const PHYSICAL = "@{ Id = 'DISPLAY\\XMI3447\\5&8577A71&0&UID4357'; Parent = 'PCI\\VEN_10DE&DEV_2709&SUBSYS_51371462&REV_A1\\4&256a0aa8&0&0008' }";
const VIRTUAL = "@{ Id = 'DISPLAY\\MTT1337\\1&28A6823A&0&UID256'; Parent = 'ROOT\\DISPLAY\\0000' }";
const RDP = "@{ Id = 'DISPLAY\\DEFAULT_MONITOR\\1&1F0C3C2F&0&UID256'; Parent = 'SWD\\RemoteDisplayEnum\\RdpIdd_IndirectDisplay&SessionId_0002' }";
const TEAMVIEWER = "@{ Id = 'DISPLAY\\TMV0000\\1&21F647DF&1&UID256'; Parent = 'SWD\\TVVirtualMonitor_IndirectDisplay\\TVVirtualMonitor_IndirectDisplay_0' }";
const UNREADABLE = "@{ Id = 'DISPLAY\\ABC0000\\1'; Parent = $null }";

describe.if(process.platform === "win32")("DisplayOff never leaves the console session with no screen", () => {
  it("refuses when someone is signed in at the console and the PC has no monitor of its own", async () => {
    const r = await runHelperScenario({ pieces: DISPLAY, setup: `$global:ConsoleSession = 2; $global:Monitors = @(${VIRTUAL})`, call: "Invoke-DisplayOff" });
    expect(r.ok).toBe(false);
    expect(r.message).toStartWith("Kept on:");
    expect(r.calls).toEqual([]);
  }, T);

  it("does not count RDP's or TeamViewer's monitors, nor one whose parent cannot be read", async () => {
    const r = await runHelperScenario({
      pieces: DISPLAY,
      setup: `$global:ConsoleSession = 2; $global:Monitors = @(${VIRTUAL}, ${RDP}, ${TEAMVIEWER}, ${UNREADABLE})`,
      call: "Invoke-DisplayOff",
    });
    expect(r.ok).toBe(false);
    expect(r.calls).toEqual([]);
  }, T);

  it("turns off when the PC has a monitor of its own", async () => {
    const r = await runHelperScenario({ pieces: DISPLAY, setup: `$global:ConsoleSession = 2; $global:Monitors = @(${VIRTUAL}, ${PHYSICAL})`, call: "Invoke-DisplayOff" });
    expect(r.ok).toBe(true);
    expect(r.calls).toEqual(["disable ROOT\\DISPLAY\\0000"]);
  }, T);

  it("turns off when nobody is signed in at the console (the session is in RDP, or disconnected)", async () => {
    const r = await runHelperScenario({ pieces: DISPLAY, setup: `$global:ConsoleSession = -1; $global:Monitors = @(${VIRTUAL})`, call: "Invoke-DisplayOff" });
    expect(r.ok).toBe(true);
    expect(r.calls).toEqual(["disable ROOT\\DISPLAY\\0000"]);
  }, T);

  it("says the driver is missing rather than claiming it turned anything off", async () => {
    const r = await runHelperScenario({ pieces: DISPLAY, setup: "$global:VirtualDevices = @()", call: "Invoke-DisplayOff" });
    expect(r.ok).toBe(false);
    expect(r.message).toContain("not installed");
    expect(r.calls).toEqual([]);
  }, T);

  it("turning on is never refused by the rule", async () => {
    const r = await runHelperScenario({ pieces: DISPLAY, setup: `$global:ConsoleSession = 2`, call: "Invoke-DisplayOn" });
    expect(r.ok).toBe(true);
    expect(r.calls).toEqual(["enable ROOT\\DISPLAY\\0000"]);
  }, T);
});
