import { describe, test, expect } from "bun:test";
import {
  desktopDirs, loadDesktopEntries, collectApps, primaryPids, execBinaryIndex,
  type AppProcess,
} from "../../../../src/services/system-services/apps-linux.ts";
import {
  iconRoots, buildIconIndex, resolveIconPath, hasImageExtension, iconMimeType,
} from "../../../../src/services/system-services/app-icons-linux.ts";
import type { LinuxFs } from "../../../../src/services/system-metrics/linux-fs.ts";

const fsOf = (files: Record<string, string>, dirs: Record<string, string[]> = {}): LinuxFs => ({
  read: (p: string) => files[p] ?? null,
  list: (p: string) => dirs[p] ?? null,
  readlink: () => null,
  realpath: (p: string) => p,
  exists: (p: string) => p in files || p in dirs,
});

const entry = (name: string, extra = "") =>
  `[Desktop Entry]\nType=Application\nName=${name}\n${extra}`;

describe("desktopDirs", () => {
  test("XDG precedence, most specific first", () => {
    expect(desktopDirs({ XDG_DATA_DIRS: "/usr/local/share:/usr/share" }, "/home/t")).toEqual([
      "/home/t/.local/share/applications",
      "/usr/local/share/applications",
      "/usr/share/applications",
    ]);
  });

  test("XDG_DATA_HOME overrides the default, and duplicates collapse", () => {
    const dirs = desktopDirs({ XDG_DATA_HOME: "/usr/share", XDG_DATA_DIRS: "/usr/share:/usr/share" }, "/home/t");
    expect(dirs).toEqual(["/usr/share/applications"]);
  });

  test("no XDG variables at all still gives the spec's defaults", () => {
    expect(desktopDirs({}, "/home/t")).toEqual([
      "/home/t/.local/share/applications",
      "/usr/local/share/applications",
      "/usr/share/applications",
    ]);
  });
});

describe("loadDesktopEntries", () => {
  const fs = fsOf(
    {
      "/home/applications/code.desktop": entry("My Code", "Exec=code %F\nIcon=mine\n"),
      "/usr/applications/code.desktop": entry("Visual Studio Code", "Exec=code %F\nIcon=vscode\n"),
      "/usr/applications/vlc.desktop": entry("VLC", "Exec=/usr/bin/vlc %U\nIcon=vlc\n"),
      "/usr/applications/broken.desktop": "[Desktop Entry]\nType=Link\nName=x\n",
      "/usr/applications/notes.txt": "ignored",
    },
    {
      "/home/applications": ["code.desktop"],
      "/usr/applications": ["code.desktop", "vlc.desktop", "broken.desktop", "notes.txt"],
    },
  );

  test("a user's own entry overrides the system one of the same id", () => {
    const entries = loadDesktopEntries(["/home/applications", "/usr/applications"], fs);
    expect(entries.get("code")?.name).toBe("My Code");
    expect(entries.get("vlc")?.name).toBe("VLC");
  });

  test("non-desktop files and unlaunchable entries are skipped", () => {
    const entries = loadDesktopEntries(["/usr/applications"], fs);
    expect(entries.has("notes")).toBe(false);
    expect(entries.has("broken")).toBe(false);
    expect([...entries.keys()].sort()).toEqual(["code", "vlc"]);
  });

  test("a directory that does not exist is not an error", () => {
    expect(loadDesktopEntries(["/nope"], fs).size).toBe(0);
  });
});

describe("primaryPids", () => {
  test("only the pids whose parent is outside the app", () => {
    const ppid = new Map([[10, 1], [11, 10], [12, 11], [20, 1]]);
    expect(primaryPids([12, 11, 10, 20], ppid)).toEqual([10, 20]);
  });

  test("a lone process is its own root", () => {
    expect(primaryPids([5], new Map([[5, 1]]))).toEqual([5]);
  });
});

describe("execBinaryIndex", () => {
  const entries = new Map(Object.entries({
    a: { id: "a", name: "A", icon: null, exec: "/usr/bin/foo", noDisplay: false },
    b: { id: "b", name: "B", icon: null, exec: "/opt/x/foo", noDisplay: false },
    c: { id: "c", name: "C", icon: null, exec: "bar --flag", noDisplay: false },
    d: { id: "d", name: "D", icon: null, exec: "baz", noDisplay: true },
  }));

  test("a binary two entries both claim is dropped, never resolved arbitrarily", () => {
    const index = execBinaryIndex(entries);
    expect(index.has("foo")).toBe(false);
    expect(index.get("bar")).toBe("c");
  });

  test("a NoDisplay entry never provides a fallback match", () => {
    expect(execBinaryIndex(entries).has("baz")).toBe(false);
  });
});

describe("collectApps", () => {
  const entries = new Map(Object.entries({
    code: { id: "code", name: "Visual Studio Code", icon: "vscode", exec: "code", noDisplay: false },
    vlc: { id: "vlc", name: "VLC", icon: "vlc", exec: "/usr/bin/vlc", noDisplay: false },
    helper: { id: "helper", name: "Helper", icon: null, exec: "helper", noDisplay: true },
  }));
  const proc = (pid: number, ppid: number, name: string): AppProcess => ({ pid, ppid, name });
  const scope = (unit: string) => `0::/user.slice/user-1000.slice/app.slice/${unit}\n`;

  test("an app scope names the app, and only its root pids are reported", () => {
    const apps = collectApps({
      processes: [proc(100, 1, "code"), proc(101, 100, "code"), proc(102, 101, "code")],
      entries,
      readCgroup: () => scope("app-code-100.scope"),
    });
    expect(apps).toEqual([{ id: "code", name: "Visual Studio Code", icon: "vscode", pids: [100] }]);
  });

  test("apps come back sorted by name, not by pid", () => {
    // VLC holds the LOWER pid, so pid order and name order disagree here. The
    // collation is the locale's own: "Visual Studio Code" sorts before "VLC"
    // because the third letter decides, not the case.
    const apps = collectApps({
      processes: [proc(100, 1, "vlc"), proc(200, 1, "code")],
      entries,
      readCgroup: (pid) => scope(pid === 100 ? "app-vlc-100.scope" : "app-code-200.scope"),
    });
    expect(apps.map((a) => a.id)).toEqual(["code", "vlc"]);
  });

  test("a scope naming an id no entry defines is not an app", () => {
    const apps = collectApps({
      processes: [proc(100, 1, "ghost")],
      entries,
      readCgroup: () => scope("app-ghost-100.scope"),
    });
    expect(apps).toEqual([]);
  });

  test("a NoDisplay entry is never listed, however it was matched", () => {
    const apps = collectApps({
      processes: [proc(100, 1, "helper")],
      entries,
      readCgroup: () => scope("app-helper-100.scope"),
    });
    expect(apps).toEqual([]);
  });

  test("outside a scope, only an exact executable name matches", () => {
    const apps = collectApps({
      processes: [proc(100, 1, "code"), proc(300, 1, "bash")],
      entries,
      readCgroup: () => "0::/user.slice/user-1000.slice/session.scope\n",
    });
    expect(apps.map((a) => a.id)).toEqual(["code"]);
  });

  test("a process whose cgroup cannot be read is simply not attributed", () => {
    expect(collectApps({ processes: [proc(100, 1, "zzz")], entries, readCgroup: () => null })).toEqual([]);
  });
});

describe("iconRoots", () => {
  test("themes first, then pixmaps — which some very common icons only live in", () => {
    expect(iconRoots({ XDG_DATA_DIRS: "/usr/share" }, "/home/t")).toEqual([
      "/home/t/.icons",
      "/home/t/.local/share/icons",
      "/usr/share/icons",
      "/usr/share/pixmaps",
    ]);
  });
});

describe("buildIconIndex", () => {
  const fs = fsOf({}, {
    "/a": ["theme"],
    "/a/theme": ["apps"],
    "/a/theme/apps": ["dolphin.png", "dolphin.svg", "index.theme"],
    "/b": ["vscode.png", "dolphin.svg"],
  });

  test("a vector icon wins over a raster one of the same name", () => {
    expect(buildIconIndex(["/a"], fs).get("dolphin")).toBe("/a/theme/apps/dolphin.svg");
  });

  test("an earlier root wins over a later one", () => {
    expect(buildIconIndex(["/a", "/b"], fs).get("dolphin")).toBe("/a/theme/apps/dolphin.svg");
    expect(buildIconIndex(["/b", "/a"], fs).get("dolphin")).toBe("/b/dolphin.svg");
  });

  test("names from every depth are indexed, and non-images are not", () => {
    const index = buildIconIndex(["/a", "/b"], fs);
    expect(index.get("vscode")).toBe("/b/vscode.png");
    expect(index.has("index")).toBe(false);
  });
});

describe("resolveIconPath", () => {
  const index = new Map([["vscode", "/usr/share/pixmaps/vscode.png"]]);
  const fs = fsOf({ "/opt/app/icon.png": "x", "/etc/shadow": "secret" });

  test("a theme name resolves through the index", () => {
    expect(resolveIconPath("vscode", index, fs)).toBe("/usr/share/pixmaps/vscode.png");
  });

  test("an entry that wrote the file name still resolves", () => {
    expect(resolveIconPath("vscode.png", index, fs)).toBe("/usr/share/pixmaps/vscode.png");
  });

  test("an absolute path is served only when it is an image that exists", () => {
    expect(resolveIconPath("/opt/app/icon.png", index, fs)).toBe("/opt/app/icon.png");
    expect(resolveIconPath("/etc/shadow", index, fs)).toBeNull();
    expect(resolveIconPath("/opt/app/missing.png", index, fs)).toBeNull();
  });

  test("nothing to resolve is null, never a guess", () => {
    expect(resolveIconPath(null, index, fs)).toBeNull();
    expect(resolveIconPath("no-such-icon", index, fs)).toBeNull();
  });

  test("extension helpers", () => {
    expect(hasImageExtension("/a/b.SVG")).toBe(true);
    expect(hasImageExtension("/a/b.sh")).toBe(false);
    expect(iconMimeType("/a/b.svg")).toBe("image/svg+xml");
    expect(iconMimeType("/a/b")).toBe("application/octet-stream");
  });
});
