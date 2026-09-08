/**
 * Platform-neutral entry point for input injection. Picks the backend for `process.platform`
 * from the registry below; the session and routes never import a platform module directly.
 *
 * Every backend module is safe to *import* anywhere (FFI is loaded lazily inside each), so the
 * registry can hold them all statically — only the selected one ever `dlopen`s. Adding Linux =
 * `remote-desktop-input-linux.ts` + one line in `BACKENDS`.
 */
import { win32InputBackend } from "./remote-desktop-input-win32.ts";
import { darwinInputBackend } from "./remote-desktop-input-darwin.ts";
import { RemoteInputUnavailableError, type InputTargetRect, type RemoteInputBackend } from "./remote-desktop-input-backend.ts";

export { RemoteInputUnavailableError, type InputTargetRect, type RemoteInputBackend };

const BACKENDS: Partial<Record<NodeJS.Platform, RemoteInputBackend>> = {
  win32: win32InputBackend,
  darwin: darwinInputBackend,
};

/** The backend for this host, or null when the platform has none. */
export function getInputBackend(platform: NodeJS.Platform = process.platform): RemoteInputBackend | null {
  return BACKENDS[platform] ?? null;
}

/** Sync, cheap: does this platform have an injector at all? Used on the per-event hot path to
 *  drop input messages early. "Would it actually work" (OS permissions) is answered by
 *  `remote-desktop-requirements.ts`. */
export function isInputAvailable(): boolean {
  return getInputBackend() !== null;
}

function required(): RemoteInputBackend {
  const backend = getInputBackend();
  if (!backend) throw new RemoteInputUnavailableError();
  return backend;
}

export function injectPointer(
  xFrac: number, yFrac: number, button: "left" | "right" | null, down: boolean | null, target: InputTargetRect | null = null,
): Promise<void> {
  return required().pointer(xFrac, yFrac, button, down, target);
}

export function injectWheel(deltaY: number): Promise<void> {
  // A zero delta is a no-op on every OS — settle it here so no backend is even consulted.
  if (Math.round(deltaY) === 0) return Promise.resolve();
  return required().wheel(deltaY);
}

export function injectKey(code: string, down: boolean): Promise<boolean> {
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
