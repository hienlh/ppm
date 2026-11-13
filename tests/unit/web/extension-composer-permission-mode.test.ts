import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolveComposerPermissionMode } from "../../../src/web/components/extensions/extension-composer-permission-mode.ts";

/**
 * The composer used to hardcode `bypassPermissions`, so a user who deliberately
 * configured `default`/`acceptEdits` silently got the widest mode — and that value
 * is what the extension hands back to the headless turn endpoint.
 */
describe("resolveComposerPermissionMode", () => {
  const settings = {
    default_provider: "claude",
    providers: { claude: { permission_mode: "acceptEdits" }, codex: { permission_mode: "default" } },
  };

  it("an explicit option from the extension wins over the configured default", () => {
    expect(resolveComposerPermissionMode("plan", settings)).toBe("plan");
  });

  it("falls back to the default provider's configured mode", () => {
    expect(resolveComposerPermissionMode(undefined, settings)).toBe("acceptEdits");
  });

  it("reads the mode of whichever provider is the default", () => {
    expect(resolveComposerPermissionMode(undefined, { ...settings, default_provider: "codex" })).toBe("default");
  });

  it("assumes the claude provider when no default is named", () => {
    expect(resolveComposerPermissionMode(undefined, { providers: settings.providers })).toBe("acceptEdits");
  });

  it("only falls back to bypassPermissions when settings say nothing", () => {
    expect(resolveComposerPermissionMode(undefined)).toBe("bypassPermissions");
    expect(resolveComposerPermissionMode(undefined, { default_provider: "claude", providers: {} })).toBe("bypassPermissions");
  });
});

/**
 * Source-level guard, in the style of the row-forwards-ref test: this suite has no
 * DOM/React renderer, and the regression is a missing JSX `key`. The store resolves
 * one composer request and sets the next in the same render, so `composer` is never
 * null in between and MessageInput never unmounts on its own — without the key it
 * keeps the previous request's typed text and ignores the new `options.value`.
 */
describe("ExtensionComposer keys MessageInput by request", () => {
  it("renders <MessageInput> with key={composer.requestId}", () => {
    const source = readFileSync(
      resolve(import.meta.dir, "../../../src/web/components/extensions/extension-composer.tsx"),
      "utf-8",
    );
    const messageInputTag = source.slice(source.indexOf("<MessageInput"), source.indexOf("/>", source.indexOf("<MessageInput")));
    expect(messageInputTag).toContain("key={composer.requestId}");
  });
});
