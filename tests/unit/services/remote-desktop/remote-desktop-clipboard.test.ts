/**
 * Which clipboard helper each host gets, and what "not installed" looks like.
 *
 * `clipboardTool` takes the platform and the Linux session as arguments precisely so this can
 * assert every host from one machine; the tool *lookup* still reads `process.env.PATH`, so the
 * Linux cases point PATH at a temp directory holding only the binaries under test.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clipboardAvailable, clipboardTool, MAX_CLIPBOARD_CHARS, pasteComboCodes,
} from "../../../../src/services/remote-desktop/remote-desktop-clipboard.ts";
import { codeToEvdev } from "../../../../src/services/remote-desktop/remote-desktop-evdev-key-map.ts";
import type { LinuxSession } from "../../../../src/services/remote-desktop/remote-desktop-linux-session.ts";

const X11: LinuxSession = { kind: "x11", display: ":0", xauthority: null };
const WAYLAND: LinuxSession = { kind: "wayland", display: "wayland-0", runtimeDir: "/run/user/1000" };

const realPath = process.env.PATH;
afterEach(() => { process.env.PATH = realPath; });

/** A PATH containing exactly `bins` and nothing else. */
function pathWith(...bins: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "ppm-clip-"));
  for (const b of bins) writeFileSync(join(dir, b), "#!/bin/sh\n", { mode: 0o755 });
  return dir;
}

describe("clipboardTool", () => {
  it("uses the tools macOS always ships", () => {
    const tool = clipboardTool("darwin", null);
    expect(tool).toEqual({ read: ["pbpaste"], write: ["pbcopy"], base64: false });
    expect(clipboardAvailable(tool)).toBe(true);
  });

  it("base64s both directions on Windows so the console code page cannot mangle non-ASCII", () => {
    const tool = clipboardTool("win32", null)!;
    expect(tool.base64).toBe(true);
    expect(tool.read[0]).toBe("powershell");
    // Both halves must convert explicitly; a bare Get-Clipboard/Set-Clipboard would go through
    // stdout/stdin in whatever code page the console happens to be in.
    expect(tool.read.at(-1)).toContain("ToBase64String");
    expect(tool.write.at(-1)).toContain("FromBase64String");
    // An empty clipboard makes GetBytes($null) throw rather than return nothing.
    expect(tool.read.at(-1)).toContain("$null -eq $t");
    // `-Raw`, or a multi-line clipboard comes back as an array of lines.
    expect(tool.read.at(-1)).toContain("-Raw");
  });

  it("prefers xclip on an X11 session", () => {
    process.env.PATH = pathWith("xclip", "xsel");
    expect(clipboardTool("linux", X11)).toMatchObject({
      read: ["xclip", "-selection", "clipboard", "-o"],
      write: ["xclip", "-selection", "clipboard", "-i"],
    });
  });

  it("falls back to xsel when xclip is absent", () => {
    process.env.PATH = pathWith("xsel");
    expect(clipboardTool("linux", X11)).toMatchObject({
      read: ["xsel", "--clipboard", "--output"],
      write: ["xsel", "--clipboard", "--input"],
    });
  });

  it("reports the X11 tool as missing rather than pretending there is none to install", () => {
    process.env.PATH = pathWith();
    const tool = clipboardTool("linux", X11)!;
    expect(clipboardAvailable(tool)).toBe(false);
    // The point of the empty-argv shape: it still carries what to install.
    expect(tool.install).toBe("xclip");
  });

  it("never reaches for xclip on a Wayland session, even when it is installed", () => {
    // XWayland answers xclip with *its own* clipboard, which is not the one the user sees —
    // so a working xclip is worse than none here: it would silently sync the wrong clipboard.
    process.env.PATH = pathWith("xclip", "xsel");
    const tool = clipboardTool("linux", WAYLAND)!;
    expect(clipboardAvailable(tool)).toBe(false);
    expect(tool.install).toBe("wl-clipboard");
  });

  it("uses wl-clipboard on a Wayland session that has it", () => {
    process.env.PATH = pathWith("wl-copy", "wl-paste");
    expect(clipboardTool("linux", WAYLAND)).toMatchObject({
      read: ["wl-paste", "--no-newline", "--type", "text/plain"],
      write: ["wl-copy"],
    });
  });

  it("has no tool at all without a graphical session", () => {
    expect(clipboardTool("linux", null)).toBeNull();
    expect(clipboardAvailable(null)).toBe(false);
  });

  it("bounds a paste to something a human could have copied", () => {
    // A paste, not a file transfer: this bounds the WS message and the helper's stdin.
    expect(MAX_CLIPBOARD_CHARS).toBe(64 * 1024);
  });
});

describe("pasteComboCodes", () => {
  it("presses the platform's paste shortcut", () => {
    expect(pasteComboCodes("linux", false)).toEqual(["ControlLeft", "KeyV"]);
    expect(pasteComboCodes("win32", false)).toEqual(["ControlLeft", "KeyV"]);
    expect(pasteComboCodes("darwin", false)).toEqual(["MetaLeft", "KeyV"]);
  });

  it("keeps Shift when the user pressed it, so a remote terminal pastes instead of typing ^V", () => {
    expect(pasteComboCodes("linux", true)).toEqual(["ControlLeft", "ShiftLeft", "KeyV"]);
    expect(pasteComboCodes("darwin", true)).toEqual(["MetaLeft", "ShiftLeft", "KeyV"]);
  });

  it("names keys the evdev/VK tables actually carry — an unmapped code is dropped silently", () => {
    for (const shift of [true, false]) {
      for (const code of pasteComboCodes("linux", shift)) {
        expect(codeToEvdev(code)).not.toBeNull();
      }
    }
  });
});
