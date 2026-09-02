import { describe, expect, test } from "bun:test";
import { getDrives } from "../../../../src/services/host-info/host-drives.ts";
import type { RunResult } from "../../../../src/services/host-info/spawn-runner.ts";

function runResult(stdout: string, code = 0): RunResult {
  return { stdout, stderr: "", code, timedOut: false };
}

describe("getDrives win32", () => {
  test("baseline letter probe merged with CIM kind/label", async () => {
    const warnings: string[] = [];
    const drives = await getDrives("win32", warnings, {
      stat: async (p) => {
        if (p === "C:\\" || p === "D:\\") return {};
        throw new Error("ENOENT");
      },
      run: async () =>
        runResult(
          JSON.stringify([
            { DeviceID: "C:", DriveType: 3, VolumeName: "System" },
            { DeviceID: "D:", DriveType: 2, VolumeName: "USB Drive" },
          ]),
        ),
    });

    expect(drives).toEqual([
      { name: "C:", path: "C:\\", kind: "fixed", label: "System" },
      { name: "D:", path: "D:\\", kind: "removable", label: "USB Drive" },
    ]);
    expect(warnings).toEqual([]);
  });

  test("CIM timeout still ships the baseline list with kind unknown", async () => {
    const warnings: string[] = [];
    const drives = await getDrives("win32", warnings, {
      stat: async (p) => {
        if (p === "C:\\") return {};
        throw new Error("ENOENT");
      },
      run: async () => ({ stdout: "", stderr: "", code: null, timedOut: true }),
    });

    expect(drives).toEqual([{ name: "C:", path: "C:\\", kind: "unknown" }]);
    expect(warnings.some((w) => w.includes("timed out"))).toBe(true);
  });

  test("hung mapped drive never empties the whole list (per-letter timeout)", async () => {
    const warnings: string[] = [];
    const drives = await getDrives("win32", warnings, {
      stat: async (p) => {
        if (p === "C:\\") return {};
        if (p === "Z:\\") return new Promise(() => {}); // never resolves — simulates a dead network share
        throw new Error("ENOENT");
      },
      run: async () => runResult("[]"),
    });
    expect(drives.map((d) => d.name)).toEqual(["C:"]);
  }, 3000);
});

describe("getDrives darwin", () => {
  test("filters the boot-volume symlink-to-root, keeps real mounts", async () => {
    const warnings: string[] = [];
    const drives = await getDrives("darwin", warnings, {
      readdir: async () => ["Macintosh HD", "External SSD"],
      lstat: async (p) => ({ isSymbolicLink: () => p === "/Volumes/Macintosh HD" }),
      readlink: async () => "/",
    });
    expect(drives).toEqual([{ name: "External SSD", path: "/Volumes/External SSD", kind: "unknown" }]);
    expect(warnings).toEqual([]);
  });

  test("readdir failure yields a warning and an empty list, never throws", async () => {
    const warnings: string[] = [];
    const drives = await getDrives("darwin", warnings, {
      readdir: async () => {
        throw new Error("EPERM");
      },
    });
    expect(drives).toEqual([]);
    expect(warnings.some((w) => w.includes("EPERM"))).toBe(true);
  });
});

describe("getDrives linux", () => {
  test("findmnt filtered to known mount prefixes, root deduped, always present", async () => {
    const warnings: string[] = [];
    const drives = await getDrives("linux", warnings, {
      run: async () =>
        runResult(
          JSON.stringify({
            filesystems: [
              { target: "/", source: "/dev/sda1", fstype: "ext4" },
              { target: "/media/victor/USB", source: "/dev/sdb1", fstype: "vfat" },
              { target: "/boot/efi", source: "/dev/sda2", fstype: "vfat" }, // not under a known prefix — excluded
            ],
          }),
        ),
    });
    expect(drives).toEqual([
      { name: "/", path: "/", kind: "fixed" },
      { name: "USB", path: "/media/victor/USB", kind: "unknown" },
    ]);
    expect(warnings).toEqual([]);
  });

  test("falls back to /proc/mounts when findmnt fails", async () => {
    const warnings: string[] = [];
    const drives = await getDrives("linux", warnings, {
      run: async () => runResult("", 127),
      readFile: async () => "/dev/sdb1 /mnt/backup ext4 rw 0 0\n/dev/sda1 / ext4 rw 0 0\n",
    });
    expect(drives).toEqual([
      { name: "/", path: "/", kind: "fixed" },
      { name: "backup", path: "/mnt/backup", kind: "unknown" },
    ]);
    expect(warnings.some((w) => w.includes("findmnt"))).toBe(true);
  });
});
