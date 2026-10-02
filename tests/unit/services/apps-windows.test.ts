import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectWindowsApps, createWindowsAppCollector, windowsAppId, type WindowsAppSources } from "../../../src/services/system-services/apps-windows.ts";
import { createWindowsIconConverter } from "../../../src/services/system-services/app-icons-windows.ts";
import { createWindowsAppIconService } from "../../../src/services/system-services/app-icon-service.ts";

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const CODE = "C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe";
const FRAME = "C:\\Windows\\System32\\ApplicationFrameHost.exe";

function sources(over: Partial<WindowsAppSources> & { paths: Record<number, string> }): WindowsAppSources {
  return {
    windowOwners: over.windowOwners ?? (() => []),
    imagePath: (pid) => over.paths[pid] ?? null,
    describe: over.describe ?? ((exe) => ({ [CHROME]: "Google Chrome", [CODE]: "Visual Studio Code" })[exe] ?? null),
  };
}

describe("collectWindowsApps", () => {
  test("a window owner is an app, and its same-executable processes fold into it", () => {
    const processes = [
      { pid: 100, ppid: 4, name: "chrome.exe" },
      { pid: 101, ppid: 100, name: "chrome.exe" },
      { pid: 102, ppid: 100, name: "chrome.exe" },
      { pid: 200, ppid: 4, name: "notepad.exe" }, // no window: not an app
    ];
    const { apps } = collectWindowsApps(processes, sources({
      windowOwners: () => [{ pid: 100, title: "New Tab - Google Chrome" }],
      paths: { 100: CHROME, 101: CHROME, 102: CHROME, 200: "C:\\Windows\\notepad.exe" },
    }));
    expect(apps).toEqual([{ id: windowsAppId(CHROME.toLowerCase()), name: "Google Chrome", icon: "chrome.exe", pids: [100] }]);
  });

  test("a second root of the same executable is its own primary pid", () => {
    const processes = [
      { pid: 100, ppid: 4, name: "Code.exe" },
      { pid: 300, ppid: 9, name: "Code.exe" },
    ];
    const { apps } = collectWindowsApps(processes, sources({
      windowOwners: () => [{ pid: 100, title: "main.ts - ppm" }],
      paths: { 100: CODE, 300: CODE },
    }));
    expect(apps[0]!.pids).toEqual([100, 300]);
  });

  test("a process with the same name but another executable is not folded in", () => {
    const processes = [
      { pid: 100, ppid: 4, name: "chrome.exe" },
      { pid: 101, ppid: 4, name: "chrome.exe" },
    ];
    const { apps } = collectWindowsApps(processes, sources({
      windowOwners: () => [{ pid: 100, title: "Chrome" }],
      paths: { 100: CHROME, 101: "D:\\portable\\chrome.exe" },
    }));
    expect(apps[0]!.pids).toEqual([100]);
  });

  test("each Store app window is an app of its own, named by its title", () => {
    const processes = [{ pid: 50, ppid: 4, name: "ApplicationFrameHost.exe" }];
    const owners = [{ pid: 50, title: "Calculator" }];
    const { apps } = collectWindowsApps(processes, sources({ windowOwners: () => owners, paths: { 50: FRAME } }));
    expect(apps.map((a) => a.name)).toEqual(["Calculator"]);
  });

  test("two Store apps drawn by the same frame-host process are both listed", () => {
    const processes = [{ pid: 50, ppid: 4, name: "ApplicationFrameHost.exe" }];
    const { apps } = collectWindowsApps(processes, sources({
      windowOwners: () => [{ pid: 50, title: "Calculator" }, { pid: 50, title: "Settings" }],
      paths: { 50: FRAME },
    }));
    expect(apps.map((a) => a.name)).toEqual(["Calculator", "Settings"]);
  });

  test("two windows of one ordinary process are one app with one pid", () => {
    const { apps } = collectWindowsApps([{ pid: 100, ppid: 4, name: "Code.exe" }], sources({
      windowOwners: () => [{ pid: 100, title: "a.ts" }, { pid: 100, title: "b.ts" }],
      paths: { 100: CODE },
    }));
    expect(apps).toHaveLength(1);
    expect(apps[0]!.pids).toEqual([100]);
  });

  test("without a description the file name is the name; an unreadable owner is skipped", () => {
    const processes = [
      { pid: 1, ppid: 0, name: "tool.exe" },
      { pid: 2, ppid: 0, name: "elevated.exe" },
    ];
    const { apps } = collectWindowsApps(processes, sources({
      windowOwners: () => [{ pid: 1, title: "Tool" }, { pid: 2, title: "Admin thing" }],
      paths: { 1: "C:\\bin\\tool.exe" },
    }));
    expect(apps.map((a) => a.name)).toEqual(["tool"]);
  });

  test("a window whose process the tick did not list is ignored", () => {
    const { apps } = collectWindowsApps([], sources({ windowOwners: () => [{ pid: 7, title: "Gone" }], paths: { 7: CHROME } }));
    expect(apps).toEqual([]);
  });

  test("ids carry no path characters, so the icon route accepts them", () => {
    const id = windowsAppId(CHROME.toLowerCase());
    expect(id).toMatch(/^win-[0-9a-f]{16}$/);
  });
});

describe("createWindowsAppCollector", () => {
  test("the icon route can only reach executables the last tick listed", async () => {
    const collector = createWindowsAppCollector({
      windowOwners: () => [{ pid: 100, title: "Chrome" }],
      imagePath: (pid) => (pid === 100 ? CHROME : null),
      describe: () => "Google Chrome",
    });
    const [app] = collector.collect([{ pid: 100, ppid: 4, name: "chrome.exe" }]);
    expect(collector.iconSource(app!.id)).toBe(CHROME);
    expect(collector.iconSource("win-0000000000000000")).toBeNull();

    const asked: string[] = [];
    const service = createWindowsAppIconService(collector, { png: async (exe) => { asked.push(exe); return "x.png"; } });
    expect(await service.path(app!.id)).toBe("x.png");
    expect(await service.path("../etc")).toBeNull();
    expect(asked).toEqual([CHROME]);
  });
});

describe("createWindowsIconConverter", () => {
  test("extracts once per executable version and shares a pending extraction", async () => {
    const dir = mkdtempSync(join(tmpdir(), "win-icons-"));
    const exe = join(dir, "app.exe");
    writeFileSync(exe, "MZ");
    let calls = 0;
    const conv = createWindowsIconConverter(join(dir, "cache"), async (_src, out) => {
      calls++;
      writeFileSync(out, "png");
      return true;
    });
    const [a, b] = await Promise.all([conv.png(exe), conv.png(exe)]);
    expect(a).toBe(b);
    expect(await conv.png(exe)).toBe(a);
    expect(calls).toBe(1);
    expect(readdirSync(join(dir, "cache"))).toHaveLength(1);
  });

  test("a failed extraction is not retried for the same version", async () => {
    const dir = mkdtempSync(join(tmpdir(), "win-icons-"));
    const exe = join(dir, "app.exe");
    writeFileSync(exe, "MZ");
    let calls = 0;
    const conv = createWindowsIconConverter(join(dir, "cache"), async () => { calls++; return false; });
    expect(await conv.png(exe)).toBeNull();
    expect(await conv.png(exe)).toBeNull();
    expect(calls).toBe(1);
  });
});
