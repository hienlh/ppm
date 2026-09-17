/**
 * Which TypeScript service answers, and that the switch has two positions.
 *
 * The failure this guards against already happened twice, in opposite
 * directions. First, `setDiagnosticsOptions` silenced that worker's validator —
 * which read like "the built-in TypeScript support is off" — while all thirteen
 * of its providers stayed registered: a hover showed the real server's answer
 * and then "Loading…" underneath it, because Monaco's hover widget waits for
 * every provider and that one first had to fetch the whole compiler. Then the
 * fix for it was applied unconditionally, so a machine with no language server
 * at all — the default, and every phone — had no TypeScript completion or hover
 * either, with no second answer for the first one to be worse than.
 *
 * The provider assertions are against Monaco's own default list, read from the
 * installed package: an upgrade that adds a provider fails here instead of
 * quietly bringing it back on one side or missing it on the other.
 */
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import {
  BUILTIN_TS_PROVIDERS_OFF,
  BUILTIN_TS_PROVIDERS_ON,
  applyBuiltinTypeScript,
  disableBuiltinTypeScript,
  enableBuiltinTypeScript,
} from "../../../src/web/lib/lsp/monaco-builtin-typescript.ts";

const CONTRIBUTION = "node_modules/monaco-editor/esm/vs/language/typescript/monaco.contribution.js";

/** The provider flags Monaco itself defaults to, straight out of the dependency. */
function monacoDefaultProviders(): string[] {
  const source = readFileSync(CONTRIBUTION, "utf8");
  const start = source.indexOf("const modeConfigurationDefault = {");
  expect(start).toBeGreaterThan(-1);
  const block = source.slice(start, source.indexOf("};", start));
  return [...block.matchAll(/^\s*(\w+):\s*true/gm)].map((m) => m[1]!);
}

/** Records what was handed to Monaco, starting from Monaco's own compiler defaults. */
function fakeDefaults() {
  const calls: {
    mode: Record<string, boolean>[];
    diagnostics: Record<string, boolean>[];
    compiler: Record<string, unknown>[];
  } = { mode: [], diagnostics: [], compiler: [] };
  let compilerOptions: Record<string, unknown> = { target: 99, allowNonTsExtensions: true };
  return {
    calls,
    defaults: {
      setModeConfiguration: (config: Record<string, boolean>) => calls.mode.push(config),
      setDiagnosticsOptions: (options: Record<string, boolean>) => calls.diagnostics.push(options),
      getCompilerOptions: () => compilerOptions,
      setCompilerOptions: (options: Record<string, unknown>) => {
        compilerOptions = options;
        calls.compiler.push(options);
      },
    },
  };
}

describe("BUILTIN_TS_PROVIDERS_OFF", () => {
  it("covers every provider Monaco turns on by default", () => {
    // A key Monaco added and this table lacks is a provider that would still
    // register itself and compete with the language server.
    const missing = monacoDefaultProviders().filter((name) => !(name in BUILTIN_TS_PROVIDERS_OFF));

    expect(missing).toEqual([]);
  });

  it("names nothing Monaco does not have", () => {
    // The other direction: a stale key here is a silent no-op that reads as
    // coverage.
    const known = monacoDefaultProviders();
    const extra = Object.keys(BUILTIN_TS_PROVIDERS_OFF).filter((name) => !known.includes(name));

    expect(extra).toEqual([]);
  });

  it("sets every flag to false", () => {
    expect(Object.values(BUILTIN_TS_PROVIDERS_OFF).every((v) => v === false)).toBe(true);
  });

  it("turns off the provider that produced the hover spinner", () => {
    // Named explicitly: `hovers` is the one whose 13 MB worker fetch was
    // visible as "Loading…" under a hover the server had already answered.
    expect(BUILTIN_TS_PROVIDERS_OFF.hovers).toBe(false);
    expect(BUILTIN_TS_PROVIDERS_OFF.completionItems).toBe(false);
  });
});

describe("disableBuiltinTypeScript", () => {
  it("applies to both TypeScript and JavaScript", () => {
    // `.js` and `.jsx` are served by the same language server, so the built-in
    // worker has to go for both or half the files keep the second answer.
    const ts = fakeDefaults();
    const js = fakeDefaults();

    disableBuiltinTypeScript(ts.defaults, js.defaults);

    expect(ts.calls.mode).toHaveLength(1);
    expect(js.calls.mode).toHaveLength(1);
  });

  it("hands Monaco every flag off", () => {
    const ts = fakeDefaults();
    const js = fakeDefaults();

    disableBuiltinTypeScript(ts.defaults, js.defaults);

    expect(ts.calls.mode[0]).toEqual({ ...BUILTIN_TS_PROVIDERS_OFF });
  });

  it("silences the validator as well", () => {
    const ts = fakeDefaults();
    const js = fakeDefaults();

    disableBuiltinTypeScript(ts.defaults, js.defaults);

    expect(ts.calls.diagnostics[0]).toEqual({
      noSemanticValidation: true,
      noSyntaxValidation: true,
      noSuggestionDiagnostics: true,
    });
  });

  it("passes a copy, so Monaco cannot be handed shared mutable state", () => {
    const ts = fakeDefaults();
    const js = fakeDefaults();

    disableBuiltinTypeScript(ts.defaults, js.defaults);

    expect(ts.calls.mode[0]).not.toBe(js.calls.mode[0]);
  });
});

describe("BUILTIN_TS_PROVIDERS_ON", () => {
  it("names exactly the same providers as the off table", () => {
    // Two tables that can drift is how one position of the switch quietly stops covering a
    // provider the other one does.
    expect(Object.keys(BUILTIN_TS_PROVIDERS_ON).sort()).toEqual(Object.keys(BUILTIN_TS_PROVIDERS_OFF).sort());
    expect(Object.keys(BUILTIN_TS_PROVIDERS_ON).sort()).toEqual(monacoDefaultProviders().sort());
  });

  it("sets every flag to true", () => {
    expect(Object.values(BUILTIN_TS_PROVIDERS_ON).every((v) => v === true)).toBe(true);
  });
});

describe("enableBuiltinTypeScript", () => {
  it("registers every provider, for TypeScript and JavaScript both", () => {
    const ts = fakeDefaults();
    const js = fakeDefaults();

    enableBuiltinTypeScript(ts.defaults, js.defaults);

    expect(ts.calls.mode[0]).toEqual({ ...BUILTIN_TS_PROVIDERS_ON });
    expect(js.calls.mode[0]).toEqual({ ...BUILTIN_TS_PROVIDERS_ON });
  });

  it("keeps every diagnostic off", () => {
    // Semantic, because one file with no tsconfig.json and no node_modules reports "Cannot
    // find module" for every real import. Syntax, because PPM's models are named
    // `inmemory://model/N` with no extension and Monaco's defaults carry no `jsx` setting, so
    // every JSX tag would parse as a syntax error — red on every React file.
    const ts = fakeDefaults();
    const js = fakeDefaults();

    enableBuiltinTypeScript(ts.defaults, js.defaults);

    expect(ts.calls.diagnostics[0]).toEqual({
      noSemanticValidation: true,
      noSyntaxValidation: true,
      noSuggestionDiagnostics: true,
    });
  });

  it("teaches the worker about JSX, so completion survives the first tag", () => {
    // Without `jsx`, the parse stops at `<div>` and everything below it in the file loses its
    // completions — which reads as "the fallback does not work in React files".
    const ts = fakeDefaults();
    const js = fakeDefaults();

    enableBuiltinTypeScript(ts.defaults, js.defaults);

    expect(ts.calls.compiler[0]).toMatchObject({ jsx: 1, allowJs: true, allowNonTsExtensions: true });
  });

  it("merges into Monaco's own compiler options rather than replacing them", () => {
    const ts = fakeDefaults();
    const js = fakeDefaults();

    enableBuiltinTypeScript(ts.defaults, js.defaults);

    expect(ts.calls.compiler[0]).toMatchObject({ target: 99 });
  });
});

describe("applyBuiltinTypeScript", () => {
  it("unregisters the providers when a server is coming", () => {
    const ts = fakeDefaults();
    const js = fakeDefaults();

    applyBuiltinTypeScript(true, ts.defaults, js.defaults);

    expect(ts.calls.mode[0]).toEqual({ ...BUILTIN_TS_PROVIDERS_OFF });
  });

  it("registers them when none is", () => {
    const ts = fakeDefaults();
    const js = fakeDefaults();

    applyBuiltinTypeScript(false, ts.defaults, js.defaults);

    expect(ts.calls.mode[0]).toEqual({ ...BUILTIN_TS_PROVIDERS_ON });
  });

  it("follows the setting back and forth, since it can be toggled with an editor open", () => {
    const ts = fakeDefaults();
    const js = fakeDefaults();

    applyBuiltinTypeScript(false, ts.defaults, js.defaults);
    applyBuiltinTypeScript(true, ts.defaults, js.defaults);
    applyBuiltinTypeScript(false, ts.defaults, js.defaults);

    expect(ts.calls.mode.map((m) => m.hovers)).toEqual([true, false, true]);
  });
});

describe("what the editor gates it on", () => {
  const editor = readFileSync("src/web/components/editor/code-editor.tsx", "utf8");

  it("passes the device question, not the buffer's", () => {
    // Monaco's TypeScript defaults are global to the page. Gating on `lspOn` — which includes
    // `lspServable` — would let a scratch buffer no server can serve switch the built-in
    // worker back on underneath the project file in the next tab.
    expect(editor).toContain("const lspWanted = lspEnabled && !isTouchOnly;");
    expect(editor).toContain("const lspOn = lspWanted && lspServable;");
    expect(editor).toMatch(/applyBuiltinTypeScript\(\s*lspWanted,/);
  });

  it("applies it from an effect, so toggling the setting takes effect at once", () => {
    // In the mount handler it ran once per editor and never again; the Settings switch is
    // three clicks away from the editor it governs.
    expect(editor).toMatch(/applyBuiltinTypeScript\([^)]*\)[;\s]*\}, \[mounted, lspWanted\]\)/s);
    expect(editor).not.toContain("disableBuiltinTypeScript(");
  });
});
