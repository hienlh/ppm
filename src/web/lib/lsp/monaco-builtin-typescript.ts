/**
 * Which TypeScript service the editor uses, Monaco's own or a real one.
 *
 * VS Code's renderer has no TypeScript worker in it at all — every completion,
 * hover and definition comes from a real tsserver in the extension host. PPM
 * has that now too, and when a language server is coming, leaving Monaco's own
 * worker registered alongside it is not a fallback; it is a second answer that
 * is both worse and slower.
 *
 * Worse, because that worker sees one file with no `tsconfig.json` and no
 * `node_modules`, so its completions contribute nothing beyond the current
 * file's own symbols, mixed into the real server's list.
 *
 * Slower, because answering at all means fetching `ts.worker-*.js`: 6.7 MB of
 * TypeScript compiler, 1.2 MB over the wire. Monaco's hover widget merges every
 * provider's result and shows "Loading…" until the last one replies, so the real
 * server's answer arrived in milliseconds and then sat behind a spinner waiting
 * for that download.
 *
 * `setDiagnosticsOptions` does not do this. It silences the validator and
 * leaves all thirteen providers registered; `setModeConfiguration` is what
 * unregisters them.
 *
 * None of that applies when no language server is coming, which is the default:
 * the setting is off until someone turns it on. Unregistering there bought
 * nothing and cost everything — a fresh desktop install and every phone had no
 * TypeScript completion or hover at all, with no second answer to be worse than.
 * So the switch has two positions, not one.
 */

/**
 * Every provider in Monaco's `modeConfigurationDefault`.
 *
 * Spelled out rather than built from a list, so that a Monaco upgrade adding a
 * provider is caught by the test that compares these keys against Monaco's own
 * defaults — the failure this prevents is a new provider quietly registering
 * itself and competing with the language server again.
 */
const BUILTIN_TS_PROVIDERS = [
  "completionItems",
  "hovers",
  "documentSymbols",
  "definitions",
  "references",
  "documentHighlights",
  "rename",
  "diagnostics",
  "documentRangeFormattingEdits",
  "signatureHelp",
  "onTypeFormattingEdits",
  "codeActions",
  "inlayHints",
] as const;

type ProviderFlags = Record<(typeof BUILTIN_TS_PROVIDERS)[number], boolean>;

function allProviders(value: boolean): ProviderFlags {
  return Object.fromEntries(BUILTIN_TS_PROVIDERS.map((name) => [name, value])) as ProviderFlags;
}

export const BUILTIN_TS_PROVIDERS_OFF: ProviderFlags = allProviders(false);
export const BUILTIN_TS_PROVIDERS_ON: ProviderFlags = allProviders(true);

/**
 * No diagnostics in either position, and the syntax half is deliberate.
 *
 * The semantic half is obvious: one file with no `tsconfig.json` and no
 * `node_modules` reports "Cannot find module" for every real import, which is
 * how this worker's validator came to be silenced in the first place.
 *
 * The syntax half is less obvious and matters more here. PPM's models are named
 * `inmemory://model/N` with no extension, so Monaco's worker cannot tell a
 * `.tsx` from a `.ts`, and Monaco's default `compilerOptions` carry no `jsx`
 * setting — so every JSX tag in the file parses as a syntax error. Red on every
 * React file is a worse bug than the one this fallback exists to fix.
 * `setCompilerOptions` below is what keeps *completion* working inside JSX
 * regardless; diagnostics are the part with nothing to gain.
 */
const NO_DIAGNOSTICS = {
  noSemanticValidation: true,
  noSyntaxValidation: true,
  noSuggestionDiagnostics: true,
} as const;

/** `ts.JsxEmit.Preserve`. Inlined because importing TypeScript here is the download this avoids. */
const JSX_PRESERVE = 1;

/** The two `LanguageServiceDefaults` objects this has to be applied to. */
interface TypeScriptDefaultsLike {
  setModeConfiguration: (config: Record<string, boolean>) => void;
  setDiagnosticsOptions: (options: Record<string, boolean>) => void;
  getCompilerOptions: () => Record<string, unknown>;
  setCompilerOptions: (options: Record<string, unknown>) => void;
}

/**
 * Hand the language to a real server: unregister Monaco's providers entirely.
 */
export function disableBuiltinTypeScript(
  typescriptDefaults: TypeScriptDefaultsLike,
  javascriptDefaults: TypeScriptDefaultsLike,
): void {
  for (const defaults of [typescriptDefaults, javascriptDefaults]) {
    defaults.setModeConfiguration({ ...BUILTIN_TS_PROVIDERS_OFF });
    // Set as well as the mode configuration: this is what would run if a
    // future Monaco ever registered the validator independently.
    defaults.setDiagnosticsOptions({ ...NO_DIAGNOSTICS });
  }
}

/**
 * No server is coming, so let Monaco answer — completion, hover, signature
 * help, symbols — with its diagnostics off.
 *
 * `jsx: Preserve` is the load-bearing part of the compiler options: without it
 * the worker stops parsing at the first `<div>`, and everything below that tag
 * in the file loses its completions. `allowJs` is the same point for `.jsx`.
 */
export function enableBuiltinTypeScript(
  typescriptDefaults: TypeScriptDefaultsLike,
  javascriptDefaults: TypeScriptDefaultsLike,
): void {
  for (const defaults of [typescriptDefaults, javascriptDefaults]) {
    defaults.setCompilerOptions({
      ...defaults.getCompilerOptions(),
      jsx: JSX_PRESERVE,
      allowJs: true,
      allowNonTsExtensions: true,
    });
    defaults.setModeConfiguration({ ...BUILTIN_TS_PROVIDERS_ON });
    defaults.setDiagnosticsOptions({ ...NO_DIAGNOSTICS });
  }
}

/**
 * One call, so the two positions cannot drift apart or be applied in only one
 * place. `serverComing` is the *device* question — the setting, not this
 * buffer — because Monaco's language defaults are global to the page: a scratch
 * buffer no server can serve must not switch the built-in worker back on
 * underneath the project file in the next tab.
 */
export function applyBuiltinTypeScript(
  serverComing: boolean,
  typescriptDefaults: TypeScriptDefaultsLike,
  javascriptDefaults: TypeScriptDefaultsLike,
): void {
  if (serverComing) disableBuiltinTypeScript(typescriptDefaults, javascriptDefaults);
  else enableBuiltinTypeScript(typescriptDefaults, javascriptDefaults);
}
