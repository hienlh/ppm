/**
 * Turning off Monaco's bundled TypeScript language service.
 *
 * VS Code's renderer has no TypeScript worker in it at all — every completion,
 * hover and definition comes from a real tsserver in the extension host. PPM
 * has that now too, and leaving Monaco's own worker registered alongside it is
 * not a fallback; it is a second answer that is both worse and slower.
 *
 * Worse, because that worker sees one file with no `tsconfig.json` and no
 * `node_modules`. Its diagnostics were already off for exactly that reason —
 * it reported "Cannot find module" for every real import — but its completions
 * still contributed nothing beyond the current file's own symbols, mixed into
 * the real server's list.
 *
 * Slower, because answering at all means fetching `ts.worker.bundle.js`: 13 MB,
 * the whole TypeScript compiler. Monaco's hover widget merges every provider's
 * result and shows "Loading…" until the last one replies, so the real server's
 * answer arrived in milliseconds and then sat behind a spinner waiting for that
 * download to finish.
 *
 * `setDiagnosticsOptions` does not do this. It silences the validator and
 * leaves all thirteen providers registered; `setModeConfiguration` is what
 * unregisters them.
 */

/**
 * Every provider in Monaco's `modeConfigurationDefault`, all off.
 *
 * Spelled out rather than built from a list, so that a Monaco upgrade adding a
 * provider is caught by the test that compares these keys against Monaco's own
 * defaults — the failure this prevents is a new provider quietly registering
 * itself and competing with the language server again.
 */
export const BUILTIN_TS_PROVIDERS_OFF = {
  completionItems: false,
  hovers: false,
  documentSymbols: false,
  definitions: false,
  references: false,
  documentHighlights: false,
  rename: false,
  diagnostics: false,
  documentRangeFormattingEdits: false,
  signatureHelp: false,
  onTypeFormattingEdits: false,
  codeActions: false,
  inlayHints: false,
} as const;

/** The two `LanguageServiceDefaults` objects this has to be applied to. */
interface TypeScriptDefaultsLike {
  setModeConfiguration: (config: Record<string, boolean>) => void;
  setDiagnosticsOptions: (options: Record<string, boolean>) => void;
}

export function disableBuiltinTypeScript(
  typescriptDefaults: TypeScriptDefaultsLike,
  javascriptDefaults: TypeScriptDefaultsLike,
): void {
  for (const defaults of [typescriptDefaults, javascriptDefaults]) {
    defaults.setModeConfiguration({ ...BUILTIN_TS_PROVIDERS_OFF });
    // Set as well as the mode configuration: this is what would run if a
    // future Monaco ever registered the validator independently.
    defaults.setDiagnosticsOptions({
      noSemanticValidation: true,
      noSyntaxValidation: true,
      noSuggestionDiagnostics: true,
    });
  }
}
