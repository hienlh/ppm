/**
 * Platform-neutral entry point for input injection. Picks the backend for `process.platform`
 * from the registry below; the session and routes never import a platform module directly.
 *
 * Every backend module is safe to *import* anywhere (FFI is loaded lazily inside each), so the
 * registry can hold them all statically — only the selected one ever `dlopen`s.
 *
 * Linux is the one platform whose backend cannot be decided by `process.platform` alone: XTEST
 * is an X server extension and a Wayland compositor has no equivalent, so the choice is made
 * per *session* inside `linuxInputBackend`.
 */
import { win32InputBackend } from "./remote-desktop-input-win32.ts";
import { darwinInputBackend } from "./remote-desktop-input-darwin.ts";
import { x11InputBackend } from "./remote-desktop-input-linux.ts";
import { uinputInputBackend } from "./remote-desktop-input-uinput.ts";
import { detectLinuxSession } from "./remote-desktop-linux-session.ts";
import { RemoteInputUnavailableError, type InputTargetRect, type RemoteInputBackend } from "./remote-desktop-input-backend.ts";

export { RemoteInputUnavailableError, type InputTargetRect, type RemoteInputBackend };

const BACKENDS: Partial<Record<NodeJS.Platform, RemoteInputBackend>> = {
  win32: win32InputBackend,
  darwin: darwinInputBackend,
};

/** Linux picks by session, not by platform: XTEST is an X server extension, so a Wayland
 *  compositor is driven as a virtual input device through uinput instead. Returns null on a
 *  host with no graphical session at all (a headless server, a CI container) so
 *  `isInputAvailable()` stays honest there. */
function linuxInputBackend(session = detectLinuxSession()): RemoteInputBackend | null {
  if (!session) return null;
  return session.kind === "x11" ? x11InputBackend : uinputInputBackend;
}

/** The backend for this host, or null when the platform has none. `session` is only read on
 *  Linux and is passed explicitly by tests — it otherwise probes the host, which a headless
 *  runner answers differently from a desktop. */
export function getInputBackend(
  platform: NodeJS.Platform = process.platform,
  session = platform === "linux" ? detectLinuxSession() : null,
): RemoteInputBackend | null {
  if (platform === "linux") return linuxInputBackend(session);
  return BACKENDS[platform] ?? null;
}

/** Sync, cheap: does this platform have an injector at all? Used on the per-event hot path to
 *  drop input messages early. "Would it actually work" (OS permissions) is answered by
 *  `remote-desktop-requirements.ts`. */
export function isInputAvailable(): boolean {
  return getInputBackend() !== null;
}

/** Throws `RemoteInputUnavailableError`. Every caller below is `async` on purpose, so an
 *  unsupported platform surfaces as a *rejected promise* rather than a synchronous throw —
 *  the session forwards input from a WS message handler and only ever `await`s these. */
function required(): RemoteInputBackend {
  const backend = getInputBackend();
  if (!backend) throw new RemoteInputUnavailableError();
  return backend;
}

export async function injectPointer(
  xFrac: number, yFrac: number, button: "left" | "right" | null, down: boolean | null, target: InputTargetRect | null = null,
): Promise<void> {
  return required().pointer(xFrac, yFrac, button, down, target);
}

export async function injectWheel(deltaY: number): Promise<void> {
  // A zero delta is a no-op on every OS — settle it here so no backend is even consulted.
  if (Math.round(deltaY) === 0) return;
  return required().wheel(deltaY);
}

export async function injectKey(code: string, down: boolean): Promise<boolean> {
  return required().key(code, down);
}

/** Type text as-is. Resolves false when this platform's backend has no text path (the caller
 *  may fall back to per-key events or tell the user). */
export async function injectText(text: string): Promise<boolean> {
  const backend = required();
  if (!backend.text) return false;
  await backend.text(text);
  return true;
}

export async function releaseAllModifiers(): Promise<void> {
  const backend = getInputBackend();
  if (!backend) return;
  await backend.releaseAllModifiers();
}
