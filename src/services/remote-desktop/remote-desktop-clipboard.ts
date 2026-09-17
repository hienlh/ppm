/**
 * Read and write the *host's* clipboard for the remote-desktop session.
 *
 * Shelling out rather than talking X11/Win32 directly, because owning a selection is not a
 * one-shot call: an X11 clipboard owner has to stay alive answering `SelectionRequest` events
 * for as long as it holds the selection, which means an event pump for the lifetime of the
 * copy. `xclip`/`wl-copy` already fork a helper that does exactly that, so the cost of this
 * choice is one package the host may not have — surfaced as `clipboardTool() === null` and
 * an install command, never as a silent no-op (this dev host has *none* of xclip/xsel/wl-copy
 * while running a perfectly good X11 desktop, which is the same trap as `xrandr` the binary).
 *
 * Everything is text/plain. Images are deliberately out of scope: they would need a second
 * transport and the browser half only accepts them in a secure context anyway.
 */
import { existsSync } from "node:fs";
import { detectLinuxSession, linuxSessionEnv, type LinuxSession } from "./remote-desktop-linux-session.ts";

/** A paste is a paste, not a file transfer. 64 KiB is far more than any realistic snippet and
 *  bounds both the WS message and the argv/stdin handed to a helper process. */
export const MAX_CLIPBOARD_CHARS = 64 * 1024;
/** A clipboard helper that hangs (no selection owner, a wedged compositor) must not hang the
 *  session's message loop, which is awaited per WS message. */
const CLIPBOARD_TIMEOUT_MS = 2_000;

export interface ClipboardTool {
  /** Reads text/plain from the clipboard on stdout. */
  read: string[];
  /** Writes stdin to the clipboard. */
  write: string[];
  /** Both sides are base64 so no console code page can mangle non-ASCII (Windows). */
  base64: boolean;
  /** The package to install when this host has no tool at all. */
  install?: string;
}

/** PowerShell's `Get-Clipboard`/`Set-Clipboard` go through stdout/stdin, whose encoding follows
 *  the console code page — so the text is base64'd on both sides rather than trusting it.
 *  `-Raw` keeps a multi-line clipboard as one string, and the `$null` guard is needed because
 *  an empty clipboard makes `GetBytes` throw rather than return nothing. */
const WIN_READ = "$t = Get-Clipboard -Raw; if ($null -eq $t) { '' } else "
  + "{ [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($t)) }";
const WIN_WRITE = "Set-Clipboard -Value "
  + "([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd())))";

/** Which helper this host has, or null. Linux is by session type: `wl-copy` talks to the
 *  compositor and `xclip`/`xsel` to the X server, and on a Wayland session the X pair would
 *  address XWayland's own clipboard — a different clipboard from the one the user sees. */
export function clipboardTool(
  platform: NodeJS.Platform = process.platform,
  session: LinuxSession | null = platform === "linux" ? detectLinuxSession() : null,
): ClipboardTool | null {
  if (platform === "darwin") {
    return { read: ["pbpaste"], write: ["pbcopy"], base64: false };
  }
  if (platform === "win32") {
    const pwsh = ["powershell", "-NoProfile", "-NonInteractive", "-Command"];
    return { read: [...pwsh, WIN_READ], write: [...pwsh, WIN_WRITE], base64: true };
  }
  if (platform !== "linux" || !session) return null;
  if (session.kind === "wayland") {
    return has("wl-copy") && has("wl-paste")
      ? { read: ["wl-paste", "--no-newline", "--type", "text/plain"], write: ["wl-copy"], base64: false, install: "wl-clipboard" }
      : { read: [], write: [], base64: false, install: "wl-clipboard" };
  }
  if (has("xclip")) {
    return {
      read: ["xclip", "-selection", "clipboard", "-o"],
      write: ["xclip", "-selection", "clipboard", "-i"],
      base64: false,
      install: "xclip",
    };
  }
  if (has("xsel")) {
    return {
      read: ["xsel", "--clipboard", "--output"],
      write: ["xsel", "--clipboard", "--input"],
      base64: false,
      install: "xsel",
    };
  }
  return { read: [], write: [], base64: false, install: "xclip" };
}

/** `Bun.which` also finds a shell builtin/alias shape; an explicit PATH walk is enough here and
 *  keeps the tool list assertable in a test without a real binary. */
function has(bin: string): boolean {
  return (process.env.PATH ?? "").split(":").some((dir) => dir && existsSync(`${dir}/${bin}`));
}

/** True when this host can actually move the clipboard. A tool entry with empty argv means
 *  "this is the tool you want, it is not installed" — that is what carries `install` to the UI. */
export function clipboardAvailable(tool: ClipboardTool | null = clipboardTool()): boolean {
  return !!tool && tool.read.length > 0 && tool.write.length > 0;
}

/** Env a Linux helper needs to reach the session (a PPM started by its systemd user unit has
 *  no `DISPLAY`/`WAYLAND_DISPLAY` at all — same reason ffmpeg is spawned with this). */
function spawnEnv(session: LinuxSession | null): Record<string, string | undefined> {
  return session ? { ...process.env, ...linuxSessionEnv(session) } : process.env;
}

/** The host clipboard as text, or null when there is no tool, it failed, or it holds no text
 *  (an image-only clipboard reads as empty rather than as an error). */
export async function readHostClipboard(): Promise<string | null> {
  const session = process.platform === "linux" ? detectLinuxSession() : null;
  const tool = clipboardTool(process.platform, session);
  if (!clipboardAvailable(tool)) return null;
  try {
    const proc = Bun.spawn(tool!.read, { stdout: "pipe", stderr: "ignore", env: spawnEnv(session) });
    const out = await withTimeout(new Response(proc.stdout).text(), () => proc.kill());
    if (out === null) return null;
    // A non-zero exit is normal for an empty clipboard (`xclip` reports no owner), so the exit
    // code is not treated as failure — an empty read is simply an empty clipboard.
    const text = tool!.base64 ? decodeBase64(out.trim()) : out;
    return text === null || text.length === 0 ? null : text.slice(0, MAX_CLIPBOARD_CHARS);
  } catch {
    return null;
  }
}

/** Put `text` on the host clipboard. Returns whether it landed. */
export async function writeHostClipboard(text: string): Promise<boolean> {
  if (text.length === 0 || text.length > MAX_CLIPBOARD_CHARS) return false;
  const session = process.platform === "linux" ? detectLinuxSession() : null;
  const tool = clipboardTool(process.platform, session);
  if (!clipboardAvailable(tool)) return false;
  try {
    const payload = tool!.base64 ? Buffer.from(text, "utf8").toString("base64") : text;
    const proc = Bun.spawn(tool!.write, {
      stdin: new TextEncoder().encode(payload),
      stdout: "ignore",
      stderr: "ignore",
      env: spawnEnv(session),
    });
    // `xclip -i`/`wl-copy` fork a helper that keeps owning the selection and the parent exits
    // straight away, so this waits on the parent only — by design, not by accident.
    const code = await withTimeout(proc.exited, () => proc.kill());
    return code === 0;
  } catch {
    return false;
  }
}

/** Resolve `p`, or run `onTimeout` and give null, so one wedged helper cannot stall the session. */
async function withTimeout<T>(p: Promise<T>, onTimeout: () => void): Promise<T | null> {
  const timeout = Bun.sleep(CLIPBOARD_TIMEOUT_MS).then(() => null);
  const result = await Promise.race([p, timeout]);
  if (result === null) { try { onTimeout(); } catch { /* already gone */ } }
  return result as T | null;
}

/** The keys to press so the host pastes, as `KeyboardEvent.code`s to press in order (and
 *  release in reverse).
 *
 *  `shift` is not cosmetic: a terminal pastes on Ctrl+**Shift**+V and reads a plain Ctrl+V as
 *  the literal quoted-insert control code, so answering every paste with Ctrl+V would insert
 *  `^V` into every remote shell. The client sends what the user actually pressed. */
export function pasteComboCodes(platform: NodeJS.Platform, shift: boolean): string[] {
  const mod = platform === "darwin" ? "MetaLeft" : "ControlLeft";
  return shift ? [mod, "ShiftLeft", "KeyV"] : [mod, "KeyV"];
}

function decodeBase64(b64: string): string | null {
  if (b64.length === 0) return "";
  try { return Buffer.from(b64, "base64").toString("utf8"); } catch { return null; }
}
