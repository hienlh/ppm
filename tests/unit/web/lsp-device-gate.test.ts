/**
 * Which test decides whether this device starts a language server.
 *
 * A server is a real process on the host — one `typescript-language-server` was 854 MB
 * resident — so the editor gates it. It gated on `useIsMobile`, a 768px *viewport* test,
 * which meant dragging a desktop window narrower than that tore the server down mid-session
 * and dragging it back cold-started another one, diagnostics and all.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = (path: string) => readFileSync(resolve(import.meta.dir, "../../../src/web", path), "utf8");

/** A `window` whose `matchMedia` answers from a table. */
function installWindow(answers: Record<string, boolean>, innerWidth = 1920): void {
  (globalThis as any).window = {
    innerWidth,
    matchMedia: (query: string) => ({
      matches: answers[query] ?? false,
      media: query,
      addEventListener() {},
      removeEventListener() {},
    }),
  };
}

afterEach(() => {
  delete (globalThis as any).window;
});

const TOUCH_ONLY = "(pointer: coarse) and (hover: none)";

describe("isTouchOnlyDevice", () => {
  it("is true for a pointer that cannot hover", async () => {
    installWindow({ [TOUCH_ONLY]: true });
    const { isTouchOnlyDevice } = await import("../../../src/web/hooks/use-is-touch-only.ts");

    expect(isTouchOnlyDevice()).toBe(true);
  });

  it("is false for a desktop, however narrow the window is", async () => {
    installWindow({ [TOUCH_ONLY]: false }, 400); // a desktop browser at a phone's width
    const { isTouchOnlyDevice } = await import("../../../src/web/hooks/use-is-touch-only.ts");
    const { isMobileDevice } = await import("../../../src/web/hooks/use-is-mobile.ts");

    expect(isTouchOnlyDevice()).toBe(false);
    // The distinction is the whole point: the width test says phone, the device test does not.
    expect(isMobileDevice()).toBe(true);
  });

  it("answers false rather than throwing where matchMedia is missing", async () => {
    (globalThis as any).window = { innerWidth: 1920 };
    const { isTouchOnlyDevice } = await import("../../../src/web/hooks/use-is-touch-only.ts");

    expect(isTouchOnlyDevice()).toBe(false);
  });

  it("asks a media query rather than measuring the viewport", () => {
    const hook = SRC("hooks/use-is-touch-only.ts");
    expect(hook).toContain(TOUCH_ONLY);
    expect(hook).not.toContain("innerWidth");
  });
});

describe("what the editor and the setting gate on", () => {
  it("gates the language server on the device, not the viewport", () => {
    const editor = SRC("components/editor/code-editor.tsx");
    expect(editor).toContain("const lspWanted = lspEnabled && !isTouchOnly;");
    expect(editor).toContain("const lspOn = lspWanted && lspServable;");
    expect(editor).not.toMatch(/lsp(On|Wanted) = .*isPhone/);
  });

  it("gates the setting's switch the same way, so the two cannot disagree", () => {
    // A switch disabled at 767px told a desktop user they were on a phone. The switch lives in
    // the Language Servers pane now, beside the list it decides the fate of — a server
    // installed while the feature is off does nothing.
    const settings = SRC("components/settings/language-servers-section.tsx");
    expect(settings).toContain("disabled={isTouchOnly}");
    expect(settings).not.toContain("disabled={isMobile}");
    // And it went with it: two switches for one pref would drift apart.
    expect(SRC("components/settings/appearance-settings-section.tsx")).not.toContain("lspEnabled");
  });

  it("leaves word wrap on the viewport test, which is the right question for it", () => {
    // How wide the editor is, not what kind of machine it is on.
    const settings = SRC("components/settings/appearance-settings-section.tsx");
    expect(settings).toContain("checked={isMobile ? mobileWordWrap : wordWrap}");
  });
});
