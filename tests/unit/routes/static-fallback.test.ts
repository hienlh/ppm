/**
 * Which missing paths get the app shell, and which get a 404.
 *
 * Both behaviours look correct in isolation, which is why this needs pinning.
 * Answering a missing lazy chunk with `index.html` at 200 is the white screen:
 * strict MIME refusal → rejected `import()` → throw in `React.lazy` → React
 * unmounts the tree. Answering a missing *route* with 404 breaks every deep
 * link and every reload instead.
 *
 * The rule cannot be written on the path's shape, and the cases below are what
 * say so: PPM's own routes embed file paths, so `/project/x/editor/src/main.js`
 * is a navigation whose extension is `.js`.
 */
import { describe, it, expect } from "bun:test";
import { shouldServeAppShell } from "../../../src/server/routes/static-fallback.ts";

describe("a subresource is never answered with the app shell", () => {
  it("refuses a lazy chunk the upgrade deleted", () => {
    // The exact request behind the bug report: a tab open across an upgrade
    // asking for the hash it was built with.
    expect(shouldServeAppShell("/assets/settings-tab-FmY_PNER.js", "script")).toBe(false);
  });

  it("refuses anything under a build-output directory, header or no header", () => {
    // Browsers omit Fetch Metadata on an insecure origin, and PPM is routinely
    // reached over plain HTTP on a LAN — so the header alone cannot carry this.
    for (const dest of [undefined, "document", "empty", "script", "style"]) {
      expect(shouldServeAppShell("/assets/index-abc123.js", dest), String(dest)).toBe(false);
      expect(shouldServeAppShell("/assets/file-icons-abc.css", dest), String(dest)).toBe(false);
      expect(shouldServeAppShell("/assets/monaco/vs/loader.js", dest), String(dest)).toBe(false);
      expect(shouldServeAppShell("/monacoeditorwork/ts.worker.bundle.js", dest), String(dest)).toBe(false);
    }
  });

  it("refuses every declared subresource destination, wherever it lives", () => {
    for (const dest of ["script", "style", "font", "image", "worker", "serviceworker", "manifest"]) {
      expect(shouldServeAppShell("/sw.js", dest), dest).toBe(false);
      expect(shouldServeAppShell("/project/ppm/whatever", dest), dest).toBe(false);
    }
  });
});

describe("a navigation still gets the app shell", () => {
  it("serves the URL from the bug report", () => {
    expect(
      shouldServeAppShell("/project/ppm/editor/src/services/binary-upgrade-download.ts", "document"),
    ).toBe(true);
  });

  it("serves a route whose embedded file path ends in an asset extension", () => {
    // This is the case that rules out testing the extension: these are tabs.
    expect(shouldServeAppShell("/project/ppm/editor/src/web/main.js", "document")).toBe(true);
    expect(shouldServeAppShell("/project/ppm/editor/src/styles/app.css", "document")).toBe(true);
    expect(shouldServeAppShell("/project/ppm/editor/public/icon.svg", "document")).toBe(true);
    expect(shouldServeAppShell("/project/ppm/editor/manifest.webmanifest", "document")).toBe(true);
  });

  it("serves when the header is absent", () => {
    // curl, an older browser, a proxy that strips it.
    expect(shouldServeAppShell("/project/ppm", undefined)).toBe(true);
    expect(shouldServeAppShell("/", undefined)).toBe(true);
    expect(shouldServeAppShell("/project/ppm/git-diff/src/app.tsx", undefined)).toBe(true);
  });

  it("leaves fetch() alone", () => {
    // `empty` is fetch/XHR. An unknown path it asks for has always been given
    // the shell; narrowing that is a separate question from this bug, and
    // changing it here would be a silent API behaviour change.
    expect(shouldServeAppShell("/project/ppm/settings", "empty")).toBe(true);
    expect(shouldServeAppShell("/api/not-a-route", "empty")).toBe(true);
  });
});
