import { describe, test, expect } from "bun:test";
import { isImageExtension } from "../../src/shared/image-extensions.ts";

const IMAGE_PATHS = [
  "/home/user/shot.png",
  "/tmp/a.jpg",
  "/tmp/a.jpeg",
  "/tmp/a.gif",
  "/tmp/a.webp",
  "/tmp/a.bmp",
  "/tmp/a.avif",
  "/tmp/a.ico",
  "C:\\Users\\PC\\Pictures\\screenshot.PNG",
  "/var/data.v2/report.final.JPG",
];

const NON_IMAGE_PATHS = [
  "/home/user/.env",
  "/home/user/id_rsa.pem",
  "/home/user/server.key",
  "/root/.ssh/id_rsa",
  "/repo/src/index.ts",
  "/repo/README.md",
  "/etc/shadow",
  "/usr/bin/bash",
  "/tmp/archive.png.gz",
  "/tmp/pngfile",
  "/tmp/.png.txt",
];

describe("isImageExtension", () => {
  test("accepts image extensions, case-insensitively", () => {
    for (const p of IMAGE_PATHS) expect(isImageExtension(p)).toBe(true);
  });

  test("rejects secrets, code, and extensionless paths", () => {
    for (const p of NON_IMAGE_PATHS) expect(isImageExtension(p)).toBe(false);
  });

  // SVG is script-capable markup and the raw-file route serves files inline with their real
  // Content-Type, so an SVG from an arbitrary path could run script in the app's origin.
  test("rejects SVG", () => {
    expect(isImageExtension("/tmp/logo.svg")).toBe(false);
    expect(isImageExtension("/tmp/logo.SVG")).toBe(false);
  });

  test("only the final extension counts, so a double extension cannot smuggle a secret", () => {
    expect(isImageExtension("/tmp/secret.png.env")).toBe(false);
    expect(isImageExtension("/tmp/secret.env.png")).toBe(true);
  });
});
