import { describe, expect, test } from "bun:test";
import {
  buildHostInfo,
  getHostInfo,
  _resetHostInfoCache,
} from "../../../../src/services/host-info/host-info.service.ts";
import type { Drive, KnownFolder, PinnedFolder } from "../../../../src/types/system.ts";

const noDrives = async (): Promise<Drive[]> => [];
const noKnownFolders = async (): Promise<KnownFolder[]> => [];
const noPinned = async (): Promise<PinnedFolder[]> => [];

describe("buildHostInfo", () => {
  test("sep and platform follow the requested OS, not the host running the test", async () => {
    const info = await buildHostInfo("win32", "C:\\Users\\victor", "DESKTOP-1", {
      getDrives: noDrives,
      getKnownFolders: noKnownFolders,
      getPinned: noPinned,
      isDirectory: async () => true,
    });
    expect(info.platform).toBe("win32");
    expect(info.sep).toBe("\\");
    expect(info.homedir).toBe("C:\\Users\\victor");
    expect(info.hostname).toBe("DESKTOP-1");
  });

  test("darwin/linux use a forward-slash separator", async () => {
    for (const platform of ["darwin", "linux"] as const) {
      const info = await buildHostInfo(platform, "/home/victor", "host", {
        getDrives: noDrives,
        getKnownFolders: noKnownFolders,
        getPinned: noPinned,
        isDirectory: async () => true,
      });
      expect(info.sep).toBe("/");
      expect(info.platform).toBe(platform);
    }
  });

  test("drops known folders and pinned entries that no longer exist on disk", async () => {
    const info = await buildHostInfo("linux", "/home/victor", "host", {
      getDrives: noDrives,
      getKnownFolders: async () => [
        { key: "desktop", name: "Desktop", path: "/home/victor/Desktop" },
        { key: "downloads", name: "Downloads", path: "/home/victor/Deleted" },
      ],
      getPinned: async () => [{ name: "Work", path: "/home/victor/Work", source: "gtk" }],
      isDirectory: async (p) => p !== "/home/victor/Deleted",
    });
    expect(info.knownFolders).toEqual([{ key: "desktop", name: "Desktop", path: "/home/victor/Desktop" }]);
    expect(info.pinned).toEqual([{ name: "Work", path: "/home/victor/Work", source: "gtk" }]);
  });

  test("a known folder wins over a pinned duplicate at the same path", async () => {
    const info = await buildHostInfo("linux", "/home/victor", "host", {
      getDrives: noDrives,
      getKnownFolders: async () => [{ key: "desktop", name: "Desktop", path: "/home/victor/Desktop" }],
      getPinned: async () => [{ name: "Desktop (pinned)", path: "/home/victor/Desktop", source: "gtk" }],
      isDirectory: async () => true,
    });
    expect(info.knownFolders).toEqual([{ key: "desktop", name: "Desktop", path: "/home/victor/Desktop" }]);
    expect(info.pinned).toEqual([]); // the duplicate pinned entry is dropped, not duplicated
  });

  test("a provider failure never throws, and becomes a warnings[] entry", async () => {
    const info = await buildHostInfo("linux", "/home/victor", "host", {
      getDrives: async () => {
        throw new Error("boom");
      },
      getKnownFolders: noKnownFolders,
      getPinned: noPinned,
      isDirectory: async () => true,
    });
    expect(info.drives).toEqual([]);
    expect(info.warnings.some((w) => w.includes("boom"))).toBe(true);
  });

  test("a provider that never resolves is bounded by the 5s per-provider timeout", async () => {
    const info = await buildHostInfo("linux", "/home/victor", "host", {
      getDrives: () => new Promise(() => {}), // simulates a dead network share hanging the drive probe
      getKnownFolders: noKnownFolders,
      getPinned: noPinned,
      isDirectory: async () => true,
    });
    expect(info.drives).toEqual([]);
    expect(info.warnings.some((w) => w.includes("timed out"))).toBe(true);
  }, 6000);
});

describe("getHostInfo cache", () => {
  test("second call within the TTL is served from cache without re-invoking providers", async () => {
    _resetHostInfoCache();
    let calls = 0;
    const overrides = {
      getDrives: async () => {
        calls++;
        return [];
      },
      getKnownFolders: noKnownFolders,
      getPinned: noPinned,
      isDirectory: async () => true,
    };
    const first = await getHostInfo({}, overrides);
    const second = await getHostInfo({}, overrides);
    expect(second).toBe(first); // same cached object reference
    expect(calls).toBe(1);
  });

  test("refresh:true within the floor window is served from cache, no new spawn", async () => {
    _resetHostInfoCache();
    let calls = 0;
    const overrides = {
      getDrives: async () => {
        calls++;
        return [];
      },
      getKnownFolders: noKnownFolders,
      getPinned: noPinned,
      isDirectory: async () => true,
    };
    await getHostInfo({}, overrides);
    await getHostInfo({ refresh: true }, overrides); // fires well within the 5s floor
    expect(calls).toBe(1);
  });

  test("refresh:true past the floor re-invokes providers", async () => {
    _resetHostInfoCache();
    let calls = 0;
    const overrides = {
      getDrives: async () => {
        calls++;
        return [];
      },
      getKnownFolders: noKnownFolders,
      getPinned: noPinned,
      isDirectory: async () => true,
    };
    await getHostInfo({}, overrides);
    await new Promise((r) => setTimeout(r, 5100)); // clear the 5s refresh floor
    await getHostInfo({ refresh: true }, overrides);
    expect(calls).toBe(2);
  }, 8000);

  test("3 concurrent refresh:true calls share one in-flight build (1 spawn, not 3)", async () => {
    _resetHostInfoCache();
    let calls = 0;
    const overrides = {
      getDrives: async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 30)); // simulates a slow PowerShell/plutil/findmnt spawn
        return [];
      },
      getKnownFolders: noKnownFolders,
      getPinned: noPinned,
      isDirectory: async () => true,
    };
    const [a, b, c] = await Promise.all([
      getHostInfo({ refresh: true }, overrides),
      getHostInfo({ refresh: true }, overrides),
      getHostInfo({ refresh: true }, overrides),
    ]);
    expect(calls).toBe(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  test("concurrent calls on an expired (non-refresh) cache also share one in-flight build", async () => {
    _resetHostInfoCache();
    let calls = 0;
    const overrides = {
      getDrives: async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 30));
        return [];
      },
      getKnownFolders: noKnownFolders,
      getPinned: noPinned,
      isDirectory: async () => true,
    };
    await Promise.all([getHostInfo({}, overrides), getHostInfo({}, overrides), getHostInfo({}, overrides)]);
    expect(calls).toBe(1);
  });
});
