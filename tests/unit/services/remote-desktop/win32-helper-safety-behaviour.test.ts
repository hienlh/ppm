/**
 * What the SYSTEM helper actually does, run in Windows PowerShell 5.1 with every Windows call
 * replaced (`tests/helpers/windows-helper-powershell-harness.ts`). Windows only: that is where
 * PowerShell 5.1 is.
 */
import { describe, expect, it } from "bun:test";
import { runHelperScenario } from "../../../helpers/windows-helper-powershell-harness.ts";
import { VIRTUAL_DISPLAY_SAFETY } from "../../../../src/services/remote-desktop/win32-helper/virtual-display-safety-script.ts";
import { DISPLAY_OFF_ACTION, DISPLAY_ON_ACTION } from "../../../../src/services/remote-desktop/win32-helper/vdd-scripts.ts";
import { REATTACH_ACTION, STATE_FILES } from "../../../../src/services/remote-desktop/win32-helper/helper-script.ts";
import { CONFIRM_ACTION, RESCUE_ACTION, RESCUE_WINDOW } from "../../../../src/services/remote-desktop/win32-helper/rescue-script.ts";
import { RATE_LIMITS, RATE_WINDOW_MINUTES, RESCUE_MINUTES } from "../../../../src/services/remote-desktop/win32-helper/helper-paths.ts";
import { RATE_LIMIT } from "../../../../src/services/remote-desktop/win32-helper/rate-limit-script.ts";

const DISPLAY = [STATE_FILES, VIRTUAL_DISPLAY_SAFETY, RESCUE_WINDOW, RATE_LIMIT, DISPLAY_ON_ACTION.body, DISPLAY_OFF_ACTION.body];
const ALL = [...DISPLAY, REATTACH_ACTION.body, CONFIRM_ACTION.body, RESCUE_ACTION.body];
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
    expect(r.calls).toEqual(["arm-trigger", "enable ROOT\\DISPLAY\\0000"]);
  }, T);
});

const SESSION_2_DISCONNECTED = "$global:UserSessions = @([pscustomobject]@{ Id = 2; State = 4 })";
const armedFile = (deadlineMs: number, action = "Reattach") =>
  JSON.stringify({ action, armedMs: deadlineMs - RESCUE_MINUTES * 60_000, deadlineMs });

describe.if(process.platform === "win32")("the safety net goes up before anything changes", () => {
  it("Reattach arms the net (trigger and record) before it moves the session", async () => {
    const before = Date.now();
    const r = await runHelperScenario({ pieces: ALL, setup: SESSION_2_DISCONNECTED, call: "Invoke-Reattach" });
    expect(r.ok).toBe(true);
    expect(r.calls).toEqual(["arm-trigger", "tscon 2"]);
    const record = JSON.parse(r.state["rescue.json"]!);
    expect(record.action).toBe("Reattach");
    expect(record.deadlineMs - record.armedMs).toBe(RESCUE_MINUTES * 60_000);
    expect(record.armedMs).toBeGreaterThanOrEqual(before - 1000);
    // The trigger fires at the recorded deadline (to the second: the trigger has no milliseconds).
    expect(Math.abs(r.triggerMs! - record.deadlineMs)).toBeLessThan(1000);
  }, T);

  it("no net, no move: a trigger that cannot be set leaves the session where it is", async () => {
    const r = await runHelperScenario({ pieces: ALL, setup: `${SESSION_2_DISCONNECTED}; $global:TriggerFails = $true`, call: "Invoke-Reattach" });
    expect(r.ok).toBe(false);
    expect(r.calls).toEqual([]);
    expect(r.state["rescue.json"]).toBeUndefined();
  }, T);

  it("a failed tscon takes the net down again", async () => {
    const r = await runHelperScenario({ pieces: ALL, setup: `${SESSION_2_DISCONNECTED}; $global:TsconExit = 5`, call: "Invoke-Reattach" });
    expect(r.ok).toBe(false);
    expect(r.calls).toEqual(["arm-trigger", "tscon 2", "clear-trigger"]);
    expect(r.state["rescue.json"]).toBeUndefined();
  }, T);

  it("nothing to move, nothing armed", async () => {
    const r = await runHelperScenario({ pieces: ALL, setup: "$global:UserSessions = @([pscustomobject]@{ Id = 2; State = 0 })", call: "Invoke-Reattach" });
    expect(r.ok).toBe(true);
    expect(r.calls).toEqual([]);
  }, T);

  it("DisplayOn refuses to enable anything when the net cannot go up", async () => {
    const r = await runHelperScenario({ pieces: ALL, setup: "$global:TriggerFails = $true", call: "Invoke-DisplayOn" });
    expect(r.ok).toBe(false);
    expect(r.calls).toEqual([]);
  }, T);
});

describe.if(process.platform === "win32")("Confirm and Rescue", () => {
  it("Confirm takes the net down", async () => {
    const r = await runHelperScenario({ pieces: ALL, call: "Invoke-Confirm", stateFiles: { "rescue.json": armedFile(Date.now() + 60_000) } });
    expect(r.ok).toBe(true);
    expect(r.message).toContain("Reattach");
    expect(r.calls).toEqual(["clear-trigger"]);
    expect(r.state["rescue.json"]).toBeUndefined();
  }, T);

  it("Rescue after a confirm does nothing but clear its own trigger", async () => {
    const r = await runHelperScenario({ pieces: ALL, setup: "$global:ConsoleSession = 2", call: "Invoke-Rescue" });
    expect(r.ok).toBe(true);
    expect(r.calls).toEqual(["clear-trigger"]);
  }, T);

  it("Rescue before its deadline does nothing", async () => {
    const r = await runHelperScenario({
      pieces: ALL, setup: "$global:ConsoleSession = 2", call: "Invoke-Rescue",
      stateFiles: { "rescue.json": armedFile(Date.now() + 120_000) },
    });
    expect(r.message).toBe("Not due yet.");
    expect(r.calls).toEqual([]);
    expect(r.state["rescue.json"]).toBeDefined();
  }, T);

  it("unconfirmed on a PC with no monitor of its own: turns the virtual display on, then takes itself down", async () => {
    const r = await runHelperScenario({
      pieces: ALL, setup: "$global:ConsoleSession = 2", call: "Invoke-Rescue",
      stateFiles: { "rescue.json": armedFile(Date.now() - 1000, "DisplayOn") },
    });
    expect(r.ok).toBe(true);
    expect(r.message).toContain("DisplayOn was not confirmed");
    expect(r.calls).toEqual(["enable ROOT\\DISPLAY\\0000", "clear-trigger"]);
    expect(r.state["rescue.json"]).toBeUndefined();
  }, T);

  it("unconfirmed but the session has a screen: changes nothing", async () => {
    const r = await runHelperScenario({
      pieces: ALL, setup: `$global:ConsoleSession = 2; $global:Monitors = @(${PHYSICAL})`, call: "Invoke-Rescue",
      stateFiles: { "rescue.json": armedFile(Date.now() - 1000) },
    });
    expect(r.calls).toEqual(["clear-trigger"]);
  }, T);

  it("never signs anyone out and never moves a session", () => {
    expect(RESCUE_ACTION.body).not.toMatch(/logoff|logout|tscon|Invoke-Tscon|ExitWindows|shutdown|Disable-PnpDevice/i);
  });
});

/** `recent-changes.json` with `count` changes in `group`, `ageMs` ago. */
function recentChanges(group: keyof typeof RATE_LIMITS, count: number, ageMs = 60_000): string {
  const at = Date.now() - ageMs;
  return JSON.stringify({ reattach: [], display: [], [group]: Array.from({ length: count }, (_, i) => at + i) });
}

describe.if(process.platform === "win32")("a cap on how often SYSTEM changes anything", () => {
  it("refuses a fourth Reattach within the window, before arming or moving anything", async () => {
    const r = await runHelperScenario({
      pieces: ALL, setup: SESSION_2_DISCONNECTED, call: "Invoke-Reattach",
      stateFiles: { "recent-changes.json": recentChanges("reattach", RATE_LIMITS.reattach) },
    });
    expect(r.ok).toBe(false);
    expect(r.message).toStartWith("Refused:");
    expect(r.message).toContain(`${RATE_WINDOW_MINUTES} minutes`);
    expect(r.calls).toEqual([]);
  }, T);

  it("counts only changes inside the window", async () => {
    const r = await runHelperScenario({
      pieces: ALL, setup: SESSION_2_DISCONNECTED, call: "Invoke-Reattach",
      stateFiles: { "recent-changes.json": recentChanges("reattach", RATE_LIMITS.reattach, (RATE_WINDOW_MINUTES + 1) * 60_000) },
    });
    expect(r.ok).toBe(true);
    // The old entries fell out; the new one is recorded.
    expect(JSON.parse(r.state["recent-changes.json"]!).reattach).toHaveLength(1);
  }, T);

  it("records a real change, and only a real change", async () => {
    const done = await runHelperScenario({ pieces: ALL, setup: SESSION_2_DISCONNECTED, call: "Invoke-Reattach" });
    expect(JSON.parse(done.state["recent-changes.json"]!)).toMatchObject({ reattach: [expect.any(Number)], display: [] });
    const kept = await runHelperScenario({ pieces: ALL, setup: `$global:ConsoleSession = 2; $global:Monitors = @(${VIRTUAL})`, call: "Invoke-DisplayOff" });
    expect(kept.state["recent-changes.json"]).toBeUndefined();
  }, T);

  it("caps switching the virtual display, on and off together", async () => {
    const files = { "recent-changes.json": recentChanges("display", RATE_LIMITS.display) };
    const on = await runHelperScenario({ pieces: ALL, call: "Invoke-DisplayOn", stateFiles: files });
    expect(on.ok).toBe(false);
    expect(on.calls).toEqual([]);
    const off = await runHelperScenario({ pieces: ALL, setup: `$global:Monitors = @(${PHYSICAL})`, call: "Invoke-DisplayOff", stateFiles: files });
    expect(off.ok).toBe(false);
    expect(off.calls).toEqual([]);
  }, T);

  it("never caps the safety net", async () => {
    const r = await runHelperScenario({
      pieces: ALL, setup: "$global:ConsoleSession = 2", call: "Invoke-Rescue",
      stateFiles: { "recent-changes.json": recentChanges("display", 50), "rescue.json": armedFile(Date.now() - 1000) },
    });
    expect(r.calls).toEqual(["enable ROOT\\DISPLAY\\0000", "clear-trigger"]);
  }, T);
});
