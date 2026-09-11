/**
 * Monaco's bundled TypeScript providers stay unregistered.
 *
 * The failure this guards against already happened once: `setDiagnosticsOptions`
 * silenced that worker's validator, which read like "the built-in TypeScript
 * support is off", while all thirteen of its providers stayed registered. The
 * visible symptom was a hover that showed the real server's answer and then
 * "Loading…" underneath it, because Monaco's hover widget waits for every
 * provider and that one first had to fetch a 13 MB worker.
 *
 * So the assertion is against Monaco's own default list, read from the
 * installed package: a Monaco upgrade that adds a provider fails here instead
 * of quietly bringing it back.
 */
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import {
  BUILTIN_TS_PROVIDERS_OFF,
  disableBuiltinTypeScript,
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

/** Records what was handed to Monaco. */
function fakeDefaults() {
  const calls: { mode: Record<string, boolean>[]; diagnostics: Record<string, boolean>[] } = {
    mode: [], diagnostics: [],
  };
  return {
    calls,
    defaults: {
      setModeConfiguration: (config: Record<string, boolean>) => calls.mode.push(config),
      setDiagnosticsOptions: (options: Record<string, boolean>) => calls.diagnostics.push(options),
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
