/**
 * The Apps page on macOS. The paths are the shapes a real M1 Max showed (the
 * framework-nested Chrome helpers, Simulator inside Xcode, widget extensions of
 * apps nobody opened), under a made-up home directory, with the third-party apps
 * renamed.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  bundleInfo, bundlesOf, collectDarwinApps, createDarwinAppCollector, isListable, MAX_INFO_PLIST_BYTES,
  type BundleFs, type BundleInfo,
} from "../../../../src/services/system-services/apps-darwin.ts";
import type { AppProcess } from "../../../../src/services/system-services/apps-linux.ts";
import { parsePlistBytes } from "../../../../src/services/system-metrics/plist-binary.ts";
import { createDarwinProcessCollector } from "../../../../src/services/system-metrics/process-collector-darwin.ts";
import { darwinProcessPath } from "../../../../src/services/system-metrics/process-path-darwin.ts";

const HOME = "/Users/alex";
const CHROME = "/Applications/Google Chrome.app";
const CHROME_FRAMEWORK = `${CHROME}/Contents/Frameworks/Google Chrome Framework.framework/Versions/131.0.6778.86`;
const CHAT = "/Applications/Example Chat.app";
const CHAT_HELPER = `${CHAT}/Contents/Frameworks/Example Chat Helper (Renderer).app`;
const XCODE = "/Applications/Xcode.app";
const SIMULATOR = `${XCODE}/Contents/Developer/Applications/Simulator.app`;
const VPN_APP = "/Applications/Example VPN.app";
const CLOCK = "/System/Applications/Clock.app";
const FINDER = "/System/Library/CoreServices/Finder.app";
const DOCK = "/System/Library/CoreServices/Dock.app";
const SAFARI = "/System/Volumes/Preboot/Cryptexes/App/System/Applications/Safari.app";
const AGENT = `${HOME}/Library/Application Support/Example/ExampleAgent.app`;
const MENU_BAR_APP = "/Applications/Example Display.app";
const DOWNLOADED = `${HOME}/Downloads/Example Utility.app`;

const exe = (bundle: string, name: string) => `${bundle}/Contents/MacOS/${name}`;

describe("bundlesOf", () => {
  test("an app's own executable runs from its bundle", () => {
    expect(bundlesOf(exe(CHROME, "Google Chrome"))).toEqual({ apps: [CHROME], extension: false });
  });

  test("a bundle inside a framework is part of the framework, not an app", () => {
    const helper = `${CHROME_FRAMEWORK}/Helpers/Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper (Renderer)`;
    expect(bundlesOf(helper)).toEqual({ apps: [CHROME], extension: false });
    expect(bundlesOf(`${CHROME_FRAMEWORK}/Helpers/chrome_crashpad_handler`)).toEqual({ apps: [CHROME], extension: false });
    // Python's interpreter is a .app, and no app anyone opened.
    expect(bundlesOf("/Library/Frameworks/Python.framework/Versions/3.12/Resources/Python.app/Contents/MacOS/Python")).toBeNull();
  });

  test("nested apps are all named, outermost first", () => {
    expect(bundlesOf(exe(SIMULATOR, "Simulator"))!.apps).toEqual([XCODE, SIMULATOR]);
    expect(bundlesOf(exe(CHAT_HELPER, "Example Chat Helper (Renderer)"))!.apps).toEqual([CHAT, CHAT_HELPER]);
  });

  test("an app extension runs from its app, and says so", () => {
    const widget = `${CLOCK}/Contents/PlugIns/WorldClockWidget.appex/Contents/MacOS/WorldClockWidget`;
    expect(bundlesOf(widget)).toEqual({ apps: [CLOCK], extension: true });
  });

  test("a bundle counts only where the path goes on into its Contents", () => {
    expect(bundlesOf(`${HOME}/Projects/notes.app/build.sh`)).toBeNull();
    // Chrome's copy of itself under /private/var/folders is "Google Chrome.app.bundle".
    expect(bundlesOf("/private/var/folders/x/X/com.google.Chrome.code_sign_clone/c.1/Google Chrome.app.bundle/Contents/MacOS/Google Chrome")).toBeNull();
  });

  test("a path that is not absolute belongs to no bundle", () => {
    expect(bundlesOf("Contents/Library/LoginItems/Helper.app/Contents/MacOS/Helper")).toBeNull();
    expect(bundlesOf("npm exec @playwright/mcp@latest")).toBeNull();
  });
});

describe("isListable", () => {
  test("under /System, only the application folders and Finder", () => {
    expect(isListable(FINDER, true)).toBe(true);
    expect(isListable(CLOCK, true)).toBe(true);
    expect(isListable("/System/Applications/Utilities/Activity Monitor.app", true)).toBe(true);
    expect(isListable(SAFARI, true)).toBe(true);
    expect(isListable("/System/Cryptexes/App/System/Applications/Safari.app", true)).toBe(true);
    expect(isListable("/System/Library/CoreServices/Applications/Screen Sharing.app", true)).toBe(true);
    // The Dock, and regular-looking system bundles such as Batteries, are macOS itself.
    expect(isListable(DOCK, false)).toBe(false);
    expect(isListable("/System/Library/CoreServices/Batteries.app", true)).toBe(false);
  });

  test("anything in an Applications folder, a menu-bar app included", () => {
    expect(isListable(MENU_BAR_APP, false)).toBe(true);
    expect(isListable(`${HOME}/Applications/Chrome Apps.localized/Example Web App.app`, true)).toBe(true);
  });

  test("nothing under a Library folder: those are agents and updaters", () => {
    expect(isListable(AGENT, false)).toBe(false);
    expect(isListable("/Library/Application Support/Example/Example Common/Core.app", true)).toBe(false);
  });

  test("anywhere else, only an app with a window", () => {
    expect(isListable(DOWNLOADED, true)).toBe(true);
    expect(isListable("/Volumes/Installer/Setup.app", true)).toBe(true);
    expect(isListable(`${HOME}/Downloads/Tray.app`, false)).toBe(false);
  });
});

/** An Info.plist in CoreFoundation's XML form. */
function infoPlist(keys: Record<string, string | number | boolean>): Uint8Array {
  const value = (v: string | number | boolean) =>
    typeof v === "boolean" ? `<${v}/>` : typeof v === "number" ? `<integer>${v}</integer>` : `<string>${v}</string>`;
  const body = Object.entries(keys).map(([k, v]) => `<key>${k}</key>${value(v)}`).join("");
  return Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>${body}</dict></plist>`);
}

/** A filesystem of whole files, recording what it is asked. Mtimes default to 1. */
function fakeFs(files: Record<string, Uint8Array>, mtimes: Record<string, number> = {}) {
  const calls = { stat: [] as string[], read: [] as string[] };
  const fs: BundleFs = {
    stat: (path) => {
      calls.stat.push(path);
      const f = files[path];
      return f ? { mtimeMs: mtimes[path] ?? 1, size: f.byteLength } : null;
    },
    read: (path) => {
      calls.read.push(path);
      return files[path] ?? null;
    },
  };
  return { fs, calls, files, mtimes };
}

const ICON = new Uint8Array([0x69, 0x63, 0x6e, 0x73]);

describe("bundleInfo", () => {
  const { fs } = fakeFs({
    [`${CHROME}/Contents/Resources/app.icns`]: ICON,
    [`${CHAT}/Contents/Resources/electron.icns`]: ICON,
    [`${XCODE}/Contents/Resources/com.apple.dt.icon.icns`]: ICON,
  });
  const read = (bundle: string, keys: Record<string, string | number | boolean>) =>
    bundleInfo(bundle, parsePlistBytes(infoPlist(keys)), fs);

  test("the display name first, then the bundle name, then the folder", () => {
    expect(read(CHROME, { CFBundleIdentifier: "a", CFBundleDisplayName: "Chrome", CFBundleName: "x" })!.name).toBe("Chrome");
    expect(read(CHROME, { CFBundleIdentifier: "a", CFBundleDisplayName: "  ", CFBundleName: "Google Chrome" })!.name).toBe("Google Chrome");
    expect(read(CHROME, { CFBundleIdentifier: "a" })!.name).toBe("Google Chrome");
  });

  test("a bundle without an identifier, or a plist that is not a dictionary, is no app", () => {
    expect(read(CHROME, { CFBundleName: "Google Chrome" })).toBeNull();
    expect(bundleInfo(CHROME, ["not", "a", "dict"], fs)).toBeNull();
    expect(bundleInfo(CHROME, undefined, fs)).toBeNull();
  });

  test("menu-bar-only and faceless apps are not regular, whichever way the key is written", () => {
    expect(read(CHAT, { CFBundleIdentifier: "a" })!.regular).toBe(true);
    for (const v of [true, 1, "1", "YES", "true"]) expect(read(CHAT, { CFBundleIdentifier: "a", LSUIElement: v })!.regular).toBe(false);
    expect(read(CHAT, { CFBundleIdentifier: "a", LSBackgroundOnly: true })!.regular).toBe(false);
    expect(read(CHAT, { CFBundleIdentifier: "a", LSUIElement: false, LSBackgroundOnly: "0" })!.regular).toBe(true);
  });

  test("the icon is found as LaunchServices finds it", () => {
    expect(read(CHROME, { CFBundleIdentifier: "a", CFBundleIconFile: "app.icns" })!.iconFile).toBe("app.icns");
    expect(read(CHAT, { CFBundleIdentifier: "a", CFBundleIconFile: "electron" })!.iconFile).toBe("electron.icns");
    // A dot in the name is not an extension: com.apple.dt.icon is com.apple.dt.icon.icns.
    expect(read(XCODE, { CFBundleIdentifier: "a", CFBundleIconFile: "com.apple.dt.icon" })!.iconFile).toBe("com.apple.dt.icon.icns");
  });

  test("an icon that is missing, undeclared, or outside Resources is none", () => {
    expect(read(CHROME, { CFBundleIdentifier: "a", CFBundleIconFile: "AppIcon" })!.iconFile).toBeNull();
    expect(read(CHROME, { CFBundleIdentifier: "a" })!.iconFile).toBeNull();
    expect(read(CHROME, { CFBundleIdentifier: "a", CFBundleIconFile: "../../MacOS/Google Chrome" })!.iconFile).toBeNull();
    expect(read(CHROME, { CFBundleIdentifier: "a", CFBundleIconFile: "/etc/passwd" })!.iconFile).toBeNull();
  });

  test("Safari's real Info.plist, which ships in binary form", () => {
    const bytes = new Uint8Array(readFileSync(join(import.meta.dir, "../system-metrics/fixtures/darwin/info-plist-safari.bplist")));
    const info = bundleInfo(SAFARI, parsePlistBytes(bytes), fakeFs({ [`${SAFARI}/Contents/Resources/AppIcon.icns`]: ICON }).fs);
    expect(info).toEqual({ id: "com.apple.Safari", name: "Safari", regular: true, iconFile: "AppIcon.icns" });
  });
});

const app = (id: string, name: string, over: Partial<BundleInfo> = {}): BundleInfo =>
  ({ id, name, regular: true, iconFile: "AppIcon.icns", ...over });

/** What each bundle's Info.plist says. Anything not here has none. */
const INFO: Record<string, BundleInfo> = {
  [CHROME]: app("com.google.Chrome", "Google Chrome", { iconFile: "app.icns" }),
  [CHAT]: app("com.example.chat", "Example Chat", { iconFile: "electron.icns" }),
  [CHAT_HELPER]: app("com.example.chat.helper.Renderer", "Example Chat Helper (Renderer)", { regular: false, iconFile: null }),
  [XCODE]: app("com.apple.dt.Xcode", "Xcode"),
  [SIMULATOR]: app("com.apple.iphonesimulator", "Simulator"),
  [VPN_APP]: app("com.example.vpn", "Example VPN"),
  [CLOCK]: app("com.apple.clock", "Clock"),
  [FINDER]: app("com.apple.finder", "Finder", { iconFile: "Finder.icns" }),
  [DOCK]: app("com.apple.dock", "Dock", { regular: false }),
  [AGENT]: app("com.example.agent", "ExampleAgent", { regular: false }),
  [MENU_BAR_APP]: app("com.example.display", "Example Display", { regular: false }),
};
const lookup = (bundle: string) => INFO[bundle] ?? null;

const proc = (pid: number, ppid: number, exePath?: string): AppProcess =>
  ({ pid, ppid, name: exePath?.slice(exePath.lastIndexOf("/") + 1) ?? "x", ...(exePath ? { exePath } : {}) });

const PROCESSES: AppProcess[] = [
  proc(1, 0, "/sbin/launchd"),
  proc(100, 1, exe(CHROME, "Google Chrome")),
  proc(101, 100, `${CHROME_FRAMEWORK}/Helpers/Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper (Renderer)`),
  proc(102, 100, `${CHROME_FRAMEWORK}/Helpers/Google Chrome Helper (GPU).app/Contents/MacOS/Google Chrome Helper (GPU)`),
  // The crash reporter detaches, so it is a root of its own.
  proc(103, 1, `${CHROME_FRAMEWORK}/Helpers/chrome_crashpad_handler`),
  proc(200, 1, exe(CHAT, "Example Chat")),
  proc(201, 200, exe(CHAT_HELPER, "Example Chat Helper (Renderer)")),
  proc(300, 1, exe(XCODE, "Xcode")),
  proc(301, 1, exe(SIMULATOR, "Simulator")),
  proc(400, 1, exe(VPN_APP, "Example VPN")),
  proc(401, 1, `${VPN_APP}/Contents/PlugIns/PacketTunnel.appex/Contents/MacOS/PacketTunnel`),
  proc(500, 1, `${CLOCK}/Contents/PlugIns/WorldClockWidget.appex/Contents/MacOS/WorldClockWidget`),
  proc(600, 1, exe(FINDER, "Finder")),
  proc(601, 1, exe(DOCK, "Dock")),
  proc(700, 1, exe(AGENT, "ExampleAgent")),
  proc(800, 1, exe(MENU_BAR_APP, "Example Display")),
  // A shell started from a terminal, and a process with no path at all.
  proc(900, 200, "/bin/zsh"),
  proc(901, 1),
];

describe("collectDarwinApps", () => {
  const { apps, icons } = collectDarwinApps(PROCESSES, lookup);
  const byId = new Map(apps.map((a) => [a.id, a]));

  test("the apps a person would say are running, name-sorted", () => {
    expect(apps.map((a) => a.name)).toEqual([
      "Example Chat", "Example Display", "Example VPN", "Finder", "Google Chrome", "Simulator", "Xcode",
    ]);
  });

  test("a helper folds into its app, and each app's roots stand for their subtrees", () => {
    // 101 and 102 are under 100, so only the main process and the detached crash
    // reporter are roots.
    expect(byId.get("com.google.Chrome")!.pids).toEqual([100, 103]);
    // The chat app's LSUIElement helper is the chat app's, not an app of its own.
    expect(byId.get("com.example.chat")!.pids).toEqual([200]);
  });

  test("an app nested in another is its own app when it has a window", () => {
    expect(byId.get("com.apple.dt.Xcode")!.pids).toEqual([300]);
    expect(byId.get("com.apple.iphonesimulator")!.pids).toEqual([301]);
  });

  test("an extension counts toward its running app, and never lists one by itself", () => {
    expect(byId.get("com.example.vpn")!.pids).toEqual([400, 401]);
    // Clock's widget runs with Clock closed.
    expect(byId.has("com.apple.clock")).toBe(false);
  });

  test("the Dock and an app's own agent are not apps anyone opened", () => {
    expect(byId.has("com.apple.dock")).toBe(false);
    expect(byId.has("com.example.agent")).toBe(false);
  });

  test("each listed app's icon is its bundle's own file", () => {
    expect(byId.get("com.google.Chrome")!.icon).toBe("app.icns");
    expect(icons.get("com.google.Chrome")).toEqual({ bundle: CHROME, iconPath: `${CHROME}/Contents/Resources/app.icns` });
    expect([...icons.keys()].sort()).toEqual([...byId.keys()].sort());
    expect(icons.has("com.apple.clock")).toBe(false);
  });

  test("two copies of one app are one app: the first seen names it, both count", () => {
    const copy = `${HOME}/Downloads/Google Chrome.app`;
    const list = collectDarwinApps(
      [proc(1, 0), proc(100, 1, exe(CHROME, "Google Chrome")), proc(110, 1, exe(copy, "Google Chrome"))],
      (bundle) => (bundle === copy ? app("com.google.Chrome", "Chrome (copy)") : lookup(bundle)),
    );
    expect(list.apps).toEqual([{ id: "com.google.Chrome", name: "Google Chrome", icon: "app.icns", pids: [100, 110] }]);
    expect(list.icons.get("com.google.Chrome")!.bundle).toBe(CHROME);
  });

  test("an innermost bundle without an Info.plist falls back to the one around it", () => {
    const list = collectDarwinApps([proc(1, 0), proc(10, 1, exe(`${CHAT}/Contents/Frameworks/Broken.app`, "Broken"))], lookup);
    expect(list.apps.map((a) => a.id)).toEqual(["com.example.chat"]);
  });

  test("no processes, no apps", () => {
    expect(collectDarwinApps([], lookup)).toEqual({ apps: [], icons: new Map() });
  });
});

describe("createDarwinAppCollector", () => {
  const PLISTS = {
    [`${CHROME}/Contents/Info.plist`]: infoPlist({ CFBundleIdentifier: "com.google.Chrome", CFBundleName: "Google Chrome", CFBundleIconFile: "app.icns" }),
    [`${CHROME}/Contents/Resources/app.icns`]: ICON,
    [`${CHAT}/Contents/Info.plist`]: infoPlist({ CFBundleIdentifier: "com.example.chat", CFBundleName: "Example Chat" }),
    [`${CHAT_HELPER}/Contents/Info.plist`]: infoPlist({ CFBundleIdentifier: "com.example.chat.helper", LSUIElement: true }),
  };
  const RUNNING = PROCESSES.filter((p) => [1, 100, 101, 102, 103, 200, 201].includes(p.pid));

  test("reads each Info.plist once, and stats it once a tick however many processes share it", () => {
    const { fs, calls } = fakeFs(PLISTS);
    const collector = createDarwinAppCollector(fs);
    expect(collector.collect(RUNNING).map((a) => a.name)).toEqual(["Example Chat", "Google Chrome"]);
    expect(collector.collect(RUNNING).map((a) => a.name)).toEqual(["Example Chat", "Google Chrome"]);
    expect(calls.read.sort()).toEqual([`${CHROME}/Contents/Info.plist`, `${CHAT}/Contents/Info.plist`, `${CHAT_HELPER}/Contents/Info.plist`].sort());
    // Four Chrome processes, one stat of its Info.plist per tick.
    expect(calls.stat.filter((p) => p === `${CHROME}/Contents/Info.plist`)).toHaveLength(2);
  });

  test("an app that was updated is read again", () => {
    const { fs, calls, files, mtimes } = fakeFs({ ...PLISTS });
    const collector = createDarwinAppCollector(fs);
    collector.collect(RUNNING);
    files[`${CHAT}/Contents/Info.plist`] = infoPlist({ CFBundleIdentifier: "com.example.chat", CFBundleName: "Example Chat 5" });
    mtimes[`${CHAT}/Contents/Info.plist`] = 2;
    expect(collector.collect(RUNNING).map((a) => a.name)).toEqual(["Example Chat 5", "Google Chrome"]);
    expect(calls.read.filter((p) => p === `${CHAT}/Contents/Info.plist`)).toHaveLength(2);
  });

  test("an Info.plist too big to be one is not read", () => {
    const { fs, calls } = fakeFs({ [`${CHROME}/Contents/Info.plist`]: new Uint8Array(MAX_INFO_PLIST_BYTES + 1) });
    expect(createDarwinAppCollector(fs).collect(RUNNING)).toEqual([]);
    expect(calls.read).toEqual([]);
  });

  test("the icon route can ask only for an app the last tick listed", () => {
    const collector = createDarwinAppCollector(fakeFs(PLISTS).fs);
    expect(collector.iconSource("com.google.Chrome")).toBeNull();
    collector.collect(RUNNING);
    expect(collector.iconSource("com.google.Chrome")).toEqual({ bundle: CHROME, iconPath: `${CHROME}/Contents/Resources/app.icns` });
    // The chat app declares no icon; an id no tick listed is nothing.
    expect(collector.iconSource("com.example.chat")).toBeNull();
    expect(collector.iconSource("com.apple.dock")).toBeNull();
    // Chrome quit.
    collector.collect(RUNNING.filter((p) => p.pid < 100 || p.pid >= 200));
    expect(collector.iconSource("com.google.Chrome")).toBeNull();
  });
});

describe.if(process.platform === "darwin")("on this Mac", () => {
  test("Finder is listed with its own process, the Dock is not, and a tick stays cheap", async () => {
    const { rows } = await createDarwinProcessCollector(undefined, undefined, { processPath: darwinProcessPath }).collect();
    const collector = createDarwinAppCollector();
    collector.collect(rows);
    const started = performance.now();
    const apps = collector.collect(rows);
    // Measured at ~1 ms with every Info.plist cached, against ~50 ms cold.
    expect(performance.now() - started).toBeLessThan(25);
    const finder = rows.find((r) => r.exePath === "/System/Library/CoreServices/Finder.app/Contents/MacOS/Finder");
    if (finder) expect(apps.find((a) => a.id === "com.apple.finder")!.pids).toContain(finder.pid);
    expect(apps.some((a) => a.id === "com.apple.dock")).toBe(false);
  });
});
