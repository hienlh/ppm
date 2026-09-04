/**
 * Feature probe for the Document Picture-in-Picture API.
 *
 * `lib.dom` does not type `documentPictureInPicture` yet, so the minimal shape
 * the host actually uses is declared here and nowhere else.
 */

export interface DocumentPictureInPictureOptions {
  width?: number;
  height?: number;
}

export interface DocumentPictureInPictureApi {
  requestWindow(options?: DocumentPictureInPictureOptions): Promise<Window>;
  readonly window: Window | null;
}

declare global {
  interface Window {
    documentPictureInPicture?: DocumentPictureInPictureApi;
  }
}

/** True when this browser can open a Document PiP window (Chromium >= 116). */
export function isDocumentPipSupported(): boolean {
  return typeof window !== "undefined" && "documentPictureInPicture" in window;
}

/** The API object, or null when unsupported — keeps the cast in one place. */
export function documentPipApi(): DocumentPictureInPictureApi | null {
  if (!isDocumentPipSupported()) return null;
  return window.documentPictureInPicture ?? null;
}
