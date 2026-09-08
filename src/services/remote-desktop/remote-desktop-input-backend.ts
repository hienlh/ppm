/**
 * Contract every platform input injector implements. `remote-desktop-input.ts` picks one per
 * `process.platform`; adding an OS = one new module + one registry line there, nothing else
 * (the session and the routes only ever talk to the facade).
 *
 * All coordinates are 0..1 fractions of the captured frame — the backend owns the mapping to
 * whatever its OS wants (65535-normalised for SendInput, logical points for CoreGraphics).
 * Keys are KeyboardEvent `code`s (physical, layout-independent); the backend owns the table.
 */

export interface RemoteInputBackend {
  /** Short id for logs/diagnostics (`"win32-sendinput"`, `"darwin-cgevent"`). Whether injection
   *  would actually work right now (OS permissions) is a *requirement* in
   *  `remote-desktop-requirements.ts`, not a backend concern. */
  readonly id: string;
  pointer(xFrac: number, yFrac: number, button: "left" | "right" | null, down: boolean | null): Promise<void>;
  /** `deltaY` in wheel-notch units of 120 (positive = away from the user). */
  wheel(deltaY: number): Promise<void>;
  /** Returns false for a `code` the backend has no mapping for (caller drops it). */
  key(code: string, down: boolean): Promise<boolean>;
  /** Type a string as text, independent of layout. Optional: not every OS has a cheap path. */
  text?(text: string): Promise<void>;
  /** Force-release every modifier, regardless of tracked state — backstop for a lost keyup. */
  releaseAllModifiers(): Promise<void>;
}

export class RemoteInputUnavailableError extends Error {
  constructor(msg = `Remote input injection is not available on ${process.platform}`) {
    super(msg);
    this.name = "RemoteInputUnavailableError";
  }
}
