/**
 * Which graphical session this Linux host is running, and how to reach it.
 *
 * The PPM process very often has NO `DISPLAY` / `WAYLAND_DISPLAY` of its own: started by a
 * systemd user unit (`autostart-register.ts`), by an ssh login, or from a tmux pane detached
 * long ago, it inherits a bare environment while a full desktop session is running two feet
 * away. Reading only the env would report "no graphical session" on a machine that plainly has
 * one, so every lookup falls back to probing the sockets the session itself created.
 *
 * Wayland is checked BEFORE X11 and that order is load-bearing: a Wayland session almost
 * always also runs XWayland, which sets `DISPLAY` and answers `x11grab` — with a view of
 * XWayland clients only, i.e. a black or half-empty screen rather than an error. Preferring
 * X11 whenever it answers would therefore silently capture the wrong thing on every modern
 * GNOME/KDE-Wayland host.
 *
 * `homedir()` here is a real home path on purpose (`~/.Xauthority`), like
 * `autostart-generator.ts` — it has nothing to do with the PPM directory and must not go
 * through `getPpmDir()`.
 */
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type LinuxSession =
  /** `display` is an X display string (`":0"`); `xauthority` is best-effort — capture and XTEST
   *  both work without it when PPM runs as the session's own user, which is the normal case. */
  | { kind: "x11"; display: string; xauthority: string | null }
  | { kind: "wayland"; display: string; runtimeDir: string };

/** `$XDG_RUNTIME_DIR`, or the path systemd would have used for this uid. */
function runtimeDir(env: NodeJS.ProcessEnv): string {
  const fromEnv = env.XDG_RUNTIME_DIR?.trim();
  if (fromEnv) return fromEnv;
  return `/run/user/${typeof process.getuid === "function" ? process.getuid() : 1000}`;
}

/** Entries of `dir` matching `re`, or [] when the directory cannot be read (absent, not ours). */
function socketsIn(dir: string, re: RegExp): string[] {
  try {
    return readdirSync(dir).filter((name) => re.test(name)).sort();
  } catch {
    return [];
  }
}

/** The Wayland display name (`"wayland-0"`) for this host, or null. */
function findWaylandDisplay(env: NodeJS.ProcessEnv): string | null {
  const fromEnv = env.WAYLAND_DISPLAY?.trim();
  if (fromEnv) return fromEnv;
  // `wayland-0.lock` sits next to the socket — match the socket only.
  return socketsIn(runtimeDir(env), /^wayland-\d+$/)[0] ?? null;
}

/** The X display string (`":0"`) for this host, or null. */
function findX11Display(env: NodeJS.ProcessEnv): string | null {
  const fromEnv = env.DISPLAY?.trim();
  if (fromEnv) return fromEnv;
  const socket = socketsIn("/tmp/.X11-unix", /^X\d+$/)[0];
  return socket ? `:${socket.slice(1)}` : null;
}

/** The X authority file, or null when none is found (X still accepts the owning user locally). */
function findXauthority(env: NodeJS.ProcessEnv): string | null {
  const fromEnv = env.XAUTHORITY?.trim();
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  // What Xorg is actually started with on a modern seat: `-auth /run/user/1000/xauth_XXXXXX`.
  const dir = runtimeDir(env);
  const runtimeAuth = socketsIn(dir, /^xauth_/)[0];
  if (runtimeAuth) return join(dir, runtimeAuth);
  const legacy = join(homedir(), ".Xauthority");
  return existsSync(legacy) ? legacy : null;
}

/** The graphical session on this host, or null when there is none to capture (a headless
 *  server, a CI container). Pure w.r.t. `env` so callers can pin it in tests. */
export function detectLinuxSession(env: NodeJS.ProcessEnv = process.env): LinuxSession | null {
  // `XDG_SESSION_TYPE` is authoritative when present and stops an XWayland `DISPLAY` from
  // outvoting a Wayland session; when absent, socket order below encodes the same preference.
  const declared = env.XDG_SESSION_TYPE?.trim().toLowerCase();

  if (declared !== "x11") {
    const wayland = findWaylandDisplay(env);
    if (wayland) return { kind: "wayland", display: wayland, runtimeDir: runtimeDir(env) };
  }
  if (declared !== "wayland") {
    const display = findX11Display(env);
    if (display) return { kind: "x11", display, xauthority: findXauthority(env) };
  }
  return null;
}

/** Env additions a child process (ffmpeg) needs to reach the session. Spread over
 *  `process.env`, never used alone — ffmpeg still needs `PATH`. */
export function linuxSessionEnv(session: LinuxSession): Record<string, string> {
  if (session.kind === "wayland") {
    return { WAYLAND_DISPLAY: session.display, XDG_RUNTIME_DIR: session.runtimeDir };
  }
  return session.xauthority
    ? { DISPLAY: session.display, XAUTHORITY: session.xauthority }
    : { DISPLAY: session.display };
}
