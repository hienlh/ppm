import { describe, expect, it } from "bun:test";
import { decodeWindowsMonitorInfo, listWindowsDisplays, windowsVirtualScreen } from "../../../../src/services/remote-desktop/remote-desktop-displays-win32.ts";

function monitorInfo(device: string, rect: [number, number, number, number], primary = false): Uint8Array {
  const bytes = new Uint8Array(104);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 104, true);
  rect.forEach((value, i) => view.setInt32(4 + i * 4, value, true));
  view.setUint32(36, primary ? 1 : 0, true);
  [...device].forEach((value, i) => view.setUint16(40 + i * 2, value.charCodeAt(0), true));
  return bytes;
}

describe("Windows monitor rectangles", () => {
  it("reads full monitor bounds, not the work area, and preserves negative physical offsets", () => {
    const bytes = monitorInfo("\\\\.\\DISPLAY2", [-2560, -1440, 0, 0]);
    new DataView(bytes.buffer).setInt32(32, -40, true); // a shorter work area excludes the taskbar
    expect(decodeWindowsMonitorInfo(bytes)).toEqual({
      id: "\\\\.\\DISPLAY2", label: "Display 2", primary: false,
      x: -2560, y: -1440, width: 2560, height: 1440, captureIndex: 0,
    });
  });

  it("identifies the primary by its flag, with device ID independent of enumeration index", () => {
    expect(decodeWindowsMonitorInfo(monitorInfo("\\\\.\\DISPLAY3", [0, 0, 3840, 2160], true)))
      .toMatchObject({ id: "\\\\.\\DISPLAY3", label: "Display 3", primary: true, width: 3840, height: 2160 });
  });

  it("ignores incomplete or empty monitor records", () => {
    expect(decodeWindowsMonitorInfo(new Uint8Array(40))).toBeNull();
    expect(decodeWindowsMonitorInfo(monitorInfo("", [0, 0, 100, 100]))).toBeNull();
    expect(decodeWindowsMonitorInfo(monitorInfo("\\\\.\\DISPLAY1", [0, 0, 0, 100]))).toBeNull();
  });

  it.skipIf(process.platform !== "win32")("native monitor rectangles match the virtual desktop bounds and retain IDs", () => {
    const first = listWindowsDisplays();
    const second = listWindowsDisplays();
    const monitors = first.filter((display) => display.id !== "desktop");
    expect(monitors.length).toBeGreaterThan(0);
    expect(first.map((display) => display.id)).toEqual(second.map((display) => display.id));
    expect(first.filter((display) => display.primary)).toHaveLength(1);
    expect(first.find((display) => display.primary)?.id).not.toBe("desktop");
    const x = Math.min(...monitors.map((display) => display.x));
    const y = Math.min(...monitors.map((display) => display.y));
    const right = Math.max(...monitors.map((display) => display.x + display.width));
    const bottom = Math.max(...monitors.map((display) => display.y + display.height));
    expect(windowsVirtualScreen()).toEqual({ x, y, width: right - x, height: bottom - y });
    expect(first.find((display) => display.id === "desktop")).toMatchObject(windowsVirtualScreen());
  });
});
