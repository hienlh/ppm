/**
 * PPM's count of the PC's own monitors is the helper's: the same PowerShell, run as the user.
 */
import { afterEach, describe, expect, it } from "bun:test";
import {
  HARDWARE_MONITOR_QUERY, hardwareMonitorCount, resetHardwareMonitorCountForTests,
} from "../../../../src/services/remote-desktop/win32-helper/hardware-monitor-count.ts";
import { VIRTUAL_DISPLAY_SAFETY } from "../../../../src/services/remote-desktop/win32-helper/virtual-display-safety-script.ts";
import { setHelperSystem } from "../../../../src/services/remote-desktop/win32-helper/helper-system.ts";
import { createFakeWindows } from "../../../helpers/fake-windows-helper-system.ts";

afterEach(() => { setHelperSystem(null); resetHardwareMonitorCountForTests(); });

describe("hardwareMonitorCount", () => {
  it("runs the helper's own definition, not a second copy of it", () => {
    expect(HARDWARE_MONITOR_QUERY).toContain(VIRTUAL_DISPLAY_SAFETY);
    expect(HARDWARE_MONITOR_QUERY.trimEnd().endsWith("Get-HardwareMonitorCount")).toBe(true);
  });

  it("reads the count, caches it, and answers null when PowerShell fails or says something else", async () => {
    const win = createFakeWindows();
    let runs = 0;
    let answer = { code: 0 as number | null, stdout: "0\r\n", stderr: "" };
    win.run = async () => { runs++; return answer; };
    setHelperSystem(win);
    expect(await hardwareMonitorCount()).toBe(0);
    expect(await hardwareMonitorCount()).toBe(0);
    expect(runs).toBe(1);
    resetHardwareMonitorCountForTests();
    answer = { code: 1, stdout: "", stderr: "boom" };
    expect(await hardwareMonitorCount()).toBeNull();
    resetHardwareMonitorCountForTests();
    answer = { code: 0, stdout: "WARNING: x", stderr: "" };
    expect(await hardwareMonitorCount()).toBeNull();
  });
});
