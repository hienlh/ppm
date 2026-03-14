import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mkdirSync, existsSync, readFileSync } from "fs";
import { ConfigService } from "../../../src/services/config.service.ts";
import { FileService } from "../../../src/services/file.service.ts";
import { DEFAULT_CONFIG } from "../../../src/types/config.ts";
import { createTempDir, cleanupDir } from "../../setup.ts";

let tmpDir: string;
let svc: FileService;

beforeEach(() => {
  tmpDir = createTempDir({
    "hello.txt": "hello world",
    "sub/nested.ts": "export const x = 1;",
  });

  const configSvc = new ConfigService();
  (configSvc as unknown as { config: typeof DEFAULT_CONFIG }).config = {
    ...DEFAULT_CONFIG,
    projects: [{ path: tmpDir, name: "test-project" }],
  };
  configSvc.save = () => {};
  svc = new FileService(configSvc);
});

afterEach(() => {
  cleanupDir(tmpDir);
});

describe("FileService.getTree()", () => {
  test("returns file entries for project root", () => {
    const tree = svc.getTree("test-project");
    const names = tree.map((e) => e.name);
    expect(names).toContain("hello.txt");
    expect(names).toContain("sub");
  });

  test("directories come before files (sorted)", () => {
    const tree = svc.getTree("test-project");
    const types = tree.map((e) => e.type);
    const firstFileIdx = types.indexOf("file");
    const lastDirIdx = types.lastIndexOf("directory");
    if (firstFileIdx !== -1 && lastDirIdx !== -1) {
      expect(lastDirIdx).toBeLessThan(firstFileIdx);
    }
  });

  test("includes children for directories", () => {
    const tree = svc.getTree("test-project");
    const subDir = tree.find((e) => e.name === "sub");
    expect(subDir).toBeDefined();
    expect(subDir?.children?.some((c) => c.name === "nested.ts")).toBe(true);
  });

  test("throws when project name not found", () => {
    expect(() => svc.getTree("nonexistent")).toThrow(/Project not found/);
  });

  test("skips node_modules and .git dirs", () => {
    mkdirSync(join(tmpDir, "node_modules", "pkg"), { recursive: true });
    mkdirSync(join(tmpDir, ".git"), { recursive: true });
    const tree = svc.getTree("test-project");
    const names = tree.map((e) => e.name);
    expect(names).not.toContain("node_modules");
    expect(names).not.toContain(".git");
  });
});

describe("FileService.readFile()", () => {
  test("returns content of a text file", async () => {
    const result = await svc.readFile(join(tmpDir, "hello.txt"));
    expect(result.content).toBe("hello world");
    expect(result.encoding).toBe("utf-8");
  });

  test("returns base64 for binary files", async () => {
    const binPath = join(tmpDir, "bin.dat");
    await Bun.write(binPath, new Uint8Array([0x00, 0x01, 0x02, 0x03]));
    const result = await svc.readFile(binPath);
    expect(result.encoding).toBe("base64");
  });

  test("throws for path outside project", async () => {
    expect(svc.readFile("/etc/hosts")).rejects.toThrow(/not within a registered project/);
  });
});

describe("FileService.writeFile()", () => {
  test("writes content to existing file", async () => {
    const filePath = join(tmpDir, "hello.txt");
    await svc.writeFile(filePath, "updated content");
    expect(readFileSync(filePath, "utf8")).toBe("updated content");
  });

  test("creates new file with content", async () => {
    const filePath = join(tmpDir, "new-file.ts");
    await svc.writeFile(filePath, "const y = 2;");
    expect(readFileSync(filePath, "utf8")).toBe("const y = 2;");
  });

  test("throws for path outside project", async () => {
    expect(svc.writeFile("/tmp/outside.txt", "x")).rejects.toThrow(/not within a registered project/);
  });
});

describe("FileService.createFile()", () => {
  test("creates an empty file", async () => {
    const filePath = join(tmpDir, "created.txt");
    await svc.createFile(filePath, "file");
    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath, "utf8")).toBe("");
  });

  test("creates a directory", async () => {
    const dirPath = join(tmpDir, "new-dir");
    await svc.createFile(dirPath, "directory");
    expect(existsSync(dirPath)).toBe(true);
  });

  test("creates nested file with intermediate dirs", async () => {
    const filePath = join(tmpDir, "deep/nested/file.ts");
    await svc.createFile(filePath, "file");
    expect(existsSync(filePath)).toBe(true);
  });

  test("throws for path outside project", async () => {
    expect(svc.createFile("/tmp/x.txt", "file")).rejects.toThrow(/not within a registered project/);
  });
});

describe("FileService.deleteFile()", () => {
  test("deletes a file", () => {
    const filePath = join(tmpDir, "hello.txt");
    svc.deleteFile(filePath);
    expect(existsSync(filePath)).toBe(false);
  });

  test("deletes a directory recursively", () => {
    const dirPath = join(tmpDir, "sub");
    svc.deleteFile(dirPath);
    expect(existsSync(dirPath)).toBe(false);
  });

  test("throws when path does not exist", () => {
    expect(() => svc.deleteFile(join(tmpDir, "ghost.txt"))).toThrow(/not found/);
  });

  test("throws for path outside project", () => {
    expect(() => svc.deleteFile("/etc/hosts")).toThrow(/not within a registered project/);
  });
});

describe("FileService.renameFile()", () => {
  test("renames a file within project", () => {
    const oldPath = join(tmpDir, "hello.txt");
    const newPath = join(tmpDir, "renamed.txt");
    svc.renameFile(oldPath, newPath);
    expect(existsSync(oldPath)).toBe(false);
    expect(existsSync(newPath)).toBe(true);
  });

  test("throws when destination is outside project", () => {
    const oldPath = join(tmpDir, "hello.txt");
    expect(() => svc.renameFile(oldPath, "/tmp/escaped.txt")).toThrow(
      /Destination must be within the same project/
    );
  });

  test("throws when source is outside project", () => {
    expect(() => svc.renameFile("/etc/hosts", join(tmpDir, "x.txt"))).toThrow(
      /not within a registered project/
    );
  });
});

describe("Security: path traversal", () => {
  test("getTree rejects unknown project name", () => {
    expect(() => svc.getTree("../outside")).toThrow(/Project not found/);
  });

  test("readFile rejects ../ traversal", async () => {
    expect(svc.readFile(join(tmpDir, "../../etc/passwd"))).rejects.toThrow(
      /not within a registered project/
    );
  });

  test("writeFile rejects ../ traversal", async () => {
    expect(svc.writeFile(join(tmpDir, "../escape.txt"), "x")).rejects.toThrow(
      /not within a registered project/
    );
  });
});
