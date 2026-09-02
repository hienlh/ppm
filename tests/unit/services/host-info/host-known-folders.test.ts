import { describe, expect, test } from "bun:test";
import { getKnownFolders } from "../../../../src/services/host-info/host-known-folders.ts";
import type { RunResult } from "../../../../src/services/host-info/spawn-runner.ts";

function runResult(stdout: string, code = 0): RunResult {
  return { stdout, stderr: "", code, timedOut: false };
}

describe("getKnownFolders win32", () => {
  test("GetFolderPath + registry Downloads merged into six entries", async () => {
    const warnings: string[] = [];
    const folders = await getKnownFolders("win32", "C:\\Users\\victor", warnings, {
      run: async () =>
        runResult(
          JSON.stringify({
            desktop: "C:\\Users\\victor\\Desktop",
            documents: "C:\\Users\\victor\\Documents",
            pictures: "C:\\Users\\victor\\Pictures",
            music: "C:\\Users\\victor\\Music",
            videos: "C:\\Users\\victor\\Videos",
            downloads: "C:\\Users\\victor\\Downloads",
          }),
        ),
    });
    expect(folders.map((f) => f.key).sort()).toEqual(
      ["desktop", "documents", "downloads", "music", "pictures", "videos"].sort(),
    );
    expect(folders.find((f) => f.key === "downloads")?.path).toBe("C:\\Users\\victor\\Downloads");
    expect(warnings).toEqual([]);
  });

  test("PowerShell failure yields a warning and an empty list", async () => {
    const warnings: string[] = [];
    const folders = await getKnownFolders("win32", "C:\\Users\\victor", warnings, {
      run: async () => runResult("", 1),
    });
    expect(folders).toEqual([]);
    expect(warnings.length).toBe(1);
  });
});

describe("getKnownFolders darwin", () => {
  test("prefers iCloud CloudDocs Desktop/Documents when present, adds an icloud entry", async () => {
    const folders = await getKnownFolders("darwin", "/Users/victor", [], {
      pathExists: async (p) =>
        p === "/Users/victor/Library/Mobile Documents/com~apple~CloudDocs" ||
        p === "/Users/victor/Library/Mobile Documents/com~apple~CloudDocs/Desktop",
    });
    const desktop = folders.find((f) => f.key === "desktop");
    const documents = folders.find((f) => f.key === "documents");
    const icloud = folders.find((f) => f.key === "icloud");
    expect(desktop?.path).toBe("/Users/victor/Library/Mobile Documents/com~apple~CloudDocs/Desktop");
    expect(documents?.path).toBe("/Users/victor/Documents"); // CloudDocs/Documents doesn't exist per the stub above
    expect(icloud?.path).toBe("/Users/victor/Library/Mobile Documents/com~apple~CloudDocs");
    expect(folders.find((f) => f.key === "videos")?.path).toBe("/Users/victor/Movies");
  });

  test("no CloudDocs: plain ~/Desktop, no icloud entry", async () => {
    const folders = await getKnownFolders("darwin", "/Users/victor", [], { pathExists: async () => false });
    expect(folders.find((f) => f.key === "desktop")?.path).toBe("/Users/victor/Desktop");
    expect(folders.find((f) => f.key === "icloud")).toBeUndefined();
  });
});

describe("getKnownFolders linux", () => {
  test("xdg-user-dir per folder", async () => {
    const folders = await getKnownFolders("linux", "/home/victor", [], {
      run: async (argv) => {
        const map: Record<string, string> = {
          DESKTOP: "/home/victor/Desktop",
          DOCUMENTS: "/home/victor/Documents",
          DOWNLOAD: "/home/victor/Downloads",
          PICTURES: "/home/victor/Pictures",
          MUSIC: "/home/victor/Music",
          VIDEOS: "/home/victor/Videos",
        };
        const key = argv[1] as string;
        return runResult(map[key] ?? "/home/victor");
      },
    });
    expect(folders.find((f) => f.key === "downloads")?.path).toBe("/home/victor/Downloads");
    expect(folders.length).toBe(6);
  });

  test("falls back to user-dirs.dirs when xdg-user-dir is unavailable", async () => {
    const warnings: string[] = [];
    const folders = await getKnownFolders("linux", "/home/victor", warnings, {
      run: async () => {
        throw new Error("spawn xdg-user-dir ENOENT");
      },
      readFile: async () =>
        'XDG_DESKTOP_DIR="$HOME/Desktop"\nXDG_DOWNLOAD_DIR="$HOME/Downloads"\n# a comment line, ignored\n',
    });
    expect(folders.find((f) => f.key === "desktop")?.path).toBe("/home/victor/Desktop");
    expect(folders.find((f) => f.key === "downloads")?.path).toBe("/home/victor/Downloads");
    expect(folders.find((f) => f.key === "pictures")).toBeUndefined(); // not present in the fallback file
  });
});
