/**
 * Monaco's language providers, answered by a real language server.
 *
 * Monaco's provider interfaces and LSP's requests were designed from the same
 * model, so each function here is mostly a position conversion, one request,
 * and a shape conversion back. The interesting decisions:
 *
 * - **Registered once per Monaco language, not per editor.** Monaco calls every
 *   registered provider and merges the results, so registering on each mount
 *   would ask the server the same question once per open tab and show every
 *   suggestion N times.
 * - **A provider never throws.** Monaco treats a rejected provider promise as a
 *   broken language and can stop asking. A server that is missing, still
 *   starting, or slow has to look like "no result", so every provider swallows
 *   its failure and returns empty.
 * - **The language is decided by the model, not the registration.** A model with
 *   no registered document (an untitled buffer, a diff pane) gets nothing.
 */
import type * as MonacoType from "monaco-editor";
import { lspDocumentFor, type LspDocument } from "./lsp-documents";
import { ensureShadowModels } from "./lsp-shadow-models";
import {
  completionKind,
  fromLspRange,
  highlightKind,
  symbolKind,
  toLspPosition,
  toLspRange,
  toMarkdown,
  type LspMarkup,
  type LspRange,
  type LspTextEdit,
} from "./lsp-monaco";

/** Monaco language ids that a language server may serve. */
const REGISTERED_LANGUAGES = [
  "typescript", "javascript", "python", "html", "css", "scss", "less",
  "json", "yaml", "shell", "go", "rust", "cpp", "c", "php", "ruby", "lua",
];

/** Registered languages, so a second editor does not double every suggestion. */
const registered = new Set<string>();
let executeCommandId: string | null = null;

/**
 * Ask the server, or give up quietly.
 *
 * `null` means "no answer" for every caller here, which is what a provider
 * turns into an empty result. The alternative — letting the rejection through —
 * makes Monaco log an error per keystroke and can make it stop asking.
 */
async function ask<T>(document: LspDocument, method: string, params: unknown): Promise<T | null> {
  try {
    return await document.connection.request<T>(document.path, method, params);
  } catch {
    return null;
  }
}

/** True when the server said it can answer this. */
function supports(document: LspDocument, capability: string): boolean {
  const status = document.connection.statusOf(document.path);
  if (status?.state !== "ready") return false;
  return Boolean(status.capabilities[capability]);
}

// ── Shapes a server can answer with ────────────────────────────────────────

interface LspLocation {
  uri: string;
  range: LspRange;
}

interface LspLocationLink {
  targetUri: string;
  targetSelectionRange?: LspRange;
  targetRange: LspRange;
}

interface LspCompletionItem {
  label: string | { label: string; detail?: string; description?: string };
  kind?: number;
  detail?: string;
  documentation?: LspMarkup;
  sortText?: string;
  filterText?: string;
  preselect?: boolean;
  insertText?: string;
  insertTextFormat?: number;
  textEdit?: { range?: LspRange; insert?: LspRange; replace?: LspRange; newText: string };
  additionalTextEdits?: LspTextEdit[];
  tags?: number[];
  command?: { title: string; command: string; arguments?: unknown[] };
  data?: unknown;
}

interface LspDocumentSymbol {
  name: string;
  detail?: string;
  kind: number;
  range: LspRange;
  selectionRange: LspRange;
  children?: LspDocumentSymbol[];
  /** The flat `SymbolInformation` shape, which older servers still return. */
  location?: LspLocation;
  containerName?: string;
}

interface LspWorkspaceEdit {
  changes?: Record<string, LspTextEdit[]>;
  documentChanges?: Array<{ textDocument: { uri: string; version?: number }; edits: LspTextEdit[] }>;
}

/** Monaco items carry the original so `resolve` can send it back. */
type ResolvableItem = MonacoType.languages.CompletionItem & { __lsp?: LspCompletionItem; __path?: string };

// ── Conversions that need Monaco ───────────────────────────────────────────

function toMonacoLocations(
  monaco: typeof MonacoType,
  result: LspLocation | LspLocation[] | LspLocationLink[] | null,
): MonacoType.languages.Location[] {
  if (!result) return [];
  const list = Array.isArray(result) ? result : [result];
  return list.flatMap((entry) => {
    // `LocationLink` carries the target under different names; its selection
    // range is the identifier itself, which is where the cursor should land.
    if ("targetUri" in entry) {
      return [{
        uri: monaco.Uri.parse(entry.targetUri),
        range: fromLspRange(entry.targetSelectionRange ?? entry.targetRange),
      }];
    }
    if (!entry.uri || !entry.range) return [];
    return [{ uri: monaco.Uri.parse(entry.uri), range: fromLspRange(entry.range) }];
  });
}

/**
 * Convert locations, first making sure Monaco can resolve every file they name.
 *
 * Monaco needs a model per URI or a cross-file result does nothing — F12 goes
 * nowhere and peek opens blank. Awaiting the fetch here costs a moment on the
 * first jump into an unopened file and makes the feature work at all.
 */
async function toResolvableLocations(
  monaco: typeof MonacoType,
  document: LspDocument,
  result: LspLocation | LspLocation[] | LspLocationLink[] | null,
): Promise<MonacoType.languages.Location[]> {
  const locations = toMonacoLocations(monaco, result);
  const status = document.connection.statusOf(document.path);
  if (status?.state === "ready") {
    await ensureShadowModels(
      monaco,
      document.connection.projectName,
      status.projectPath,
      locations.map((location) => location.uri.toString()),
    );
  }
  return locations;
}

function toMonacoWorkspaceEdit(
  monaco: typeof MonacoType,
  edit: LspWorkspaceEdit | null | undefined,
): MonacoType.languages.WorkspaceEdit {
  const edits: MonacoType.languages.IWorkspaceTextEdit[] = [];

  const push = (uri: string, textEdits: LspTextEdit[]) => {
    for (const textEdit of textEdits) {
      edits.push({
        resource: monaco.Uri.parse(uri),
        versionId: undefined,
        textEdit: { range: fromLspRange(textEdit.range), text: textEdit.newText },
      });
    }
  };

  // `documentChanges` wins when present: it is the versioned form, and a server
  // that sends both means them to be the same thing.
  if (edit?.documentChanges) {
    for (const change of edit.documentChanges) {
      if (change.textDocument?.uri && Array.isArray(change.edits)) push(change.textDocument.uri, change.edits);
    }
  } else if (edit?.changes) {
    for (const [uri, textEdits] of Object.entries(edit.changes)) push(uri, textEdits);
  }

  return { edits };
}

/**
 * The range a completion replaces.
 *
 * A server may specify it three ways or not at all. When it does not, the word
 * under the cursor is the right target — using the cursor position alone would
 * insert the suggestion beside a half-typed identifier instead of completing it.
 */
function completionRange(
  model: MonacoType.editor.ITextModel,
  position: MonacoType.IPosition,
  item: LspCompletionItem,
): MonacoType.languages.CompletionItem["range"] {
  const edit = item.textEdit;
  if (edit?.insert && edit.replace) {
    return { insert: fromLspRange(edit.insert), replace: fromLspRange(edit.replace) };
  }
  if (edit?.range) return fromLspRange(edit.range);

  const word = model.getWordUntilPosition(position);
  return {
    startLineNumber: position.lineNumber,
    startColumn: word.startColumn,
    endLineNumber: position.lineNumber,
    endColumn: word.endColumn,
  };
}

function toMonacoCompletion(
  monaco: typeof MonacoType,
  model: MonacoType.editor.ITextModel,
  position: MonacoType.IPosition,
  item: LspCompletionItem,
  path: string,
): ResolvableItem {
  const label = typeof item.label === "string" ? item.label : item.label.label;
  const insertText = item.textEdit?.newText ?? item.insertText ?? label;

  const converted: ResolvableItem = {
    label: typeof item.label === "string"
      ? item.label
      : { label: item.label.label, detail: item.label.detail, description: item.label.description },
    kind: completionKind(monaco, item.kind),
    insertText,
    range: completionRange(model, position, item),
    detail: item.detail,
    documentation: toMarkdown(item.documentation),
    sortText: item.sortText,
    filterText: item.filterText,
    preselect: item.preselect,
    // 1 = Deprecated in LSP's CompletionItemTag.
    tags: item.tags?.includes(1) ? [monaco.languages.CompletionItemTag.Deprecated] : undefined,
    additionalTextEdits: item.additionalTextEdits?.map((e) => ({
      range: fromLspRange(e.range),
      text: e.newText,
    })),
    __lsp: item,
    __path: path,
  };

  // 2 = Snippet. Without this rule the placeholders arrive as literal `${1:x}`.
  if (item.insertTextFormat === 2) {
    converted.insertTextRules = monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet;
  }
  return converted;
}

function toMonacoSymbols(
  monaco: typeof MonacoType,
  symbols: LspDocumentSymbol[],
): MonacoType.languages.DocumentSymbol[] {
  return symbols.flatMap((symbol) => {
    // Servers answer with either the hierarchical `DocumentSymbol` or the flat
    // `SymbolInformation`, which puts the range inside a location instead.
    const range = symbol.range ?? symbol.location?.range;
    if (!range) return [];
    return [{
      name: symbol.name,
      detail: symbol.detail ?? symbol.containerName ?? "",
      kind: symbolKind(monaco, symbol.kind),
      tags: [],
      range: fromLspRange(range),
      selectionRange: fromLspRange(symbol.selectionRange ?? range),
      children: symbol.children ? toMonacoSymbols(monaco, symbol.children) : undefined,
    }];
  });
}

// ── Registration ───────────────────────────────────────────────────────────

/**
 * Register every provider, once per Monaco language.
 *
 * Safe to call on every editor mount; subsequent calls for a language already
 * registered do nothing.
 */
export function registerLspProviders(monaco: typeof MonacoType): void {
  if (!executeCommandId) {
    // Server-side commands (an "organize imports" action that is a command
    // rather than an edit) need somewhere to be executed. One forwarder covers
    // all of them.
    executeCommandId = "ppm.lsp.executeCommand";
    monaco.editor.registerCommand(executeCommandId, async (_accessor, args: { model?: unknown; command?: string; arguments?: unknown[] }) => {
      const model = args?.model as MonacoType.editor.ITextModel | undefined;
      const document = model ? lspDocumentFor(model) : undefined;
      if (!document || !args?.command) return;
      await ask(document, "workspace/executeCommand", { command: args.command, arguments: args.arguments ?? [] });
    });
  }

  for (const language of REGISTERED_LANGUAGES) {
    if (registered.has(language)) continue;
    registered.add(language);
    registerForLanguage(monaco, language);
  }
}

function registerForLanguage(monaco: typeof MonacoType, language: string): void {
  monaco.languages.registerCompletionItemProvider(language, {
    // The characters that should open the list without a keystroke. This is a
    // union across servers because the provider is registered before any
    // server is known; a character the server does not care about simply
    // returns nothing.
    triggerCharacters: [".", ":", ">", "<", "\"", "'", "/", "@", "#", "$", "-", " "],

    async provideCompletionItems(model, position, context) {
      const document = lspDocumentFor(model);
      if (!document || !supports(document, "completionProvider")) return { suggestions: [] };

      const result = await ask<{ items?: LspCompletionItem[]; isIncomplete?: boolean } | LspCompletionItem[]>(
        document,
        "textDocument/completion",
        {
          textDocument: { uri: model.uri.toString() },
          position: toLspPosition(position),
          context: {
            triggerKind: context.triggerKind === monaco.languages.CompletionTriggerKind.TriggerCharacter ? 2 : 1,
            triggerCharacter: context.triggerCharacter,
          },
        },
      );
      if (!result) return { suggestions: [] };

      const items = Array.isArray(result) ? result : (result.items ?? []);
      return {
        suggestions: items.map((item) => toMonacoCompletion(monaco, model, position, item, document.path)),
        // An incomplete list must be re-requested as the user keeps typing, or
        // the suggestions freeze at whatever the first prefix matched.
        incomplete: Array.isArray(result) ? false : Boolean(result.isIncomplete),
      };
    },

    async resolveCompletionItem(item) {
      const original = (item as ResolvableItem).__lsp;
      const path = (item as ResolvableItem).__path;
      if (!original || !path) return item;

      // Resolve is where the documentation and the auto-import edit arrive;
      // asking for them up front would make the whole list slow.
      const model = monaco.editor.getModels().find((m) => lspDocumentFor(m)?.path === path);
      const document = model ? lspDocumentFor(model) : undefined;
      if (!document) return item;

      const resolved = await ask<LspCompletionItem>(document, "completionItem/resolve", original);
      if (!resolved) return item;

      return {
        ...item,
        detail: resolved.detail ?? item.detail,
        documentation: toMarkdown(resolved.documentation) ?? item.documentation,
        additionalTextEdits: resolved.additionalTextEdits?.map((e) => ({
          range: fromLspRange(e.range),
          text: e.newText,
        })) ?? item.additionalTextEdits,
      };
    },
  });

  monaco.languages.registerHoverProvider(language, {
    async provideHover(model, position) {
      const document = lspDocumentFor(model);
      if (!document || !supports(document, "hoverProvider")) return null;

      const result = await ask<{ contents?: LspMarkup | LspMarkup[]; range?: LspRange }>(
        document,
        "textDocument/hover",
        { textDocument: { uri: model.uri.toString() }, position: toLspPosition(position) },
      );
      const markdown = toMarkdown(result?.contents);
      if (!markdown?.value) return null;

      return {
        contents: [markdown],
        range: result?.range ? fromLspRange(result.range) : undefined,
      };
    },
  });

  monaco.languages.registerSignatureHelpProvider(language, {
    signatureHelpTriggerCharacters: ["(", ","],
    signatureHelpRetriggerCharacters: [")"],

    async provideSignatureHelp(model, position) {
      const document = lspDocumentFor(model);
      if (!document || !supports(document, "signatureHelpProvider")) return null;

      const result = await ask<{
        signatures?: Array<{ label: string; documentation?: LspMarkup; parameters?: Array<{ label: string | [number, number]; documentation?: LspMarkup }> }>;
        activeSignature?: number;
        activeParameter?: number;
      }>(document, "textDocument/signatureHelp", {
        textDocument: { uri: model.uri.toString() },
        position: toLspPosition(position),
      });
      if (!result?.signatures?.length) return null;

      return {
        value: {
          signatures: result.signatures.map((signature) => ({
            label: signature.label,
            documentation: toMarkdown(signature.documentation),
            parameters: (signature.parameters ?? []).map((parameter) => ({
              label: parameter.label,
              documentation: toMarkdown(parameter.documentation),
            })),
          })),
          activeSignature: result.activeSignature ?? 0,
          activeParameter: result.activeParameter ?? 0,
        },
        dispose: () => {},
      };
    },
  });

  const locationProvider = (method: string, capability: string) =>
    async (model: MonacoType.editor.ITextModel, position: MonacoType.Position) => {
      const document = lspDocumentFor(model);
      if (!document || !supports(document, capability)) return [];
      const result = await ask<LspLocation | LspLocation[] | LspLocationLink[]>(document, method, {
        textDocument: { uri: model.uri.toString() },
        position: toLspPosition(position),
      });
      return toResolvableLocations(monaco, document, result);
    };

  monaco.languages.registerDefinitionProvider(language, {
    provideDefinition: locationProvider("textDocument/definition", "definitionProvider"),
  });
  monaco.languages.registerTypeDefinitionProvider(language, {
    provideTypeDefinition: locationProvider("textDocument/typeDefinition", "typeDefinitionProvider"),
  });
  monaco.languages.registerImplementationProvider(language, {
    provideImplementation: locationProvider("textDocument/implementation", "implementationProvider"),
  });

  monaco.languages.registerReferenceProvider(language, {
    async provideReferences(model, position, context) {
      const document = lspDocumentFor(model);
      if (!document || !supports(document, "referencesProvider")) return [];
      const result = await ask<LspLocation[]>(document, "textDocument/references", {
        textDocument: { uri: model.uri.toString() },
        position: toLspPosition(position),
        context: { includeDeclaration: context.includeDeclaration },
      });
      return toResolvableLocations(monaco, document, result);
    },
  });

  monaco.languages.registerDocumentHighlightProvider(language, {
    async provideDocumentHighlights(model, position) {
      const document = lspDocumentFor(model);
      if (!document || !supports(document, "documentHighlightProvider")) return [];
      const result = await ask<Array<{ range: LspRange; kind?: number }>>(document, "textDocument/documentHighlight", {
        textDocument: { uri: model.uri.toString() },
        position: toLspPosition(position),
      });
      return (result ?? []).map((highlight) => ({
        range: fromLspRange(highlight.range),
        kind: highlightKind(monaco, highlight.kind),
      }));
    },
  });

  monaco.languages.registerDocumentSymbolProvider(language, {
    async provideDocumentSymbols(model) {
      const document = lspDocumentFor(model);
      if (!document || !supports(document, "documentSymbolProvider")) return [];
      const result = await ask<LspDocumentSymbol[]>(document, "textDocument/documentSymbol", {
        textDocument: { uri: model.uri.toString() },
      });
      return toMonacoSymbols(monaco, result ?? []);
    },
  });

  monaco.languages.registerRenameProvider(language, {
    async provideRenameEdits(model, position, newName) {
      const document = lspDocumentFor(model);
      if (!document || !supports(document, "renameProvider")) {
        return { edits: [], rejectReason: "This language server cannot rename." };
      }
      const result = await ask<LspWorkspaceEdit>(document, "textDocument/rename", {
        textDocument: { uri: model.uri.toString() },
        position: toLspPosition(position),
        newName,
      });
      if (!result) return { edits: [], rejectReason: "The language server could not rename this." };
      return toMonacoWorkspaceEdit(monaco, result);
    },

    async resolveRenameLocation(model, position) {
      const document = lspDocumentFor(model);
      if (!document) return { range: emptyRangeAt(position), text: "" };

      // Without prepareRename a rename on a keyword or a string literal is
      // accepted and then silently does nothing.
      const prepare = await ask<{ range?: LspRange; placeholder?: string } | LspRange>(
        document,
        "textDocument/prepareRename",
        { textDocument: { uri: model.uri.toString() }, position: toLspPosition(position) },
      );
      if (!prepare) {
        const word = model.getWordAtPosition(position);
        if (!word) return { range: emptyRangeAt(position), text: "", rejectReason: "There is nothing here to rename." };
        return {
          range: {
            startLineNumber: position.lineNumber, startColumn: word.startColumn,
            endLineNumber: position.lineNumber, endColumn: word.endColumn,
          },
          text: word.word,
        };
      }
      const range = "range" in prepare && prepare.range ? prepare.range : (prepare as LspRange);
      const monacoRange = fromLspRange(range);
      return {
        range: monacoRange,
        text: ("placeholder" in prepare && prepare.placeholder) || model.getValueInRange(monacoRange),
      };
    },
  });

  monaco.languages.registerDocumentFormattingEditProvider(language, {
    async provideDocumentFormattingEdits(model, options) {
      const document = lspDocumentFor(model);
      if (!document || !supports(document, "documentFormattingProvider")) return [];
      const result = await ask<LspTextEdit[]>(document, "textDocument/formatting", {
        textDocument: { uri: model.uri.toString() },
        options: { tabSize: options.tabSize, insertSpaces: options.insertSpaces },
      });
      // Monaco applies a returned edit set as one transaction, so the order it
      // is given in does not matter here the way it does for a manual apply.
      return (result ?? []).map((edit) => ({ range: fromLspRange(edit.range), text: edit.newText }));
    },
  });

  monaco.languages.registerDocumentRangeFormattingEditProvider(language, {
    async provideDocumentRangeFormattingEdits(model, range, options) {
      const document = lspDocumentFor(model);
      if (!document || !supports(document, "documentRangeFormattingProvider")) return [];
      const result = await ask<LspTextEdit[]>(document, "textDocument/rangeFormatting", {
        textDocument: { uri: model.uri.toString() },
        range: toLspRange(range),
        options: { tabSize: options.tabSize, insertSpaces: options.insertSpaces },
      });
      return (result ?? []).map((edit) => ({ range: fromLspRange(edit.range), text: edit.newText }));
    },
  });

  monaco.languages.registerCodeActionProvider(language, {
    async provideCodeActions(model, range, context) {
      const document = lspDocumentFor(model);
      if (!document || !supports(document, "codeActionProvider")) return { actions: [], dispose: () => {} };

      const result = await ask<Array<{
        title: string;
        kind?: string;
        isPreferred?: boolean;
        edit?: LspWorkspaceEdit;
        command?: { title: string; command: string; arguments?: unknown[] } | string;
      }>>(document, "textDocument/codeAction", {
        textDocument: { uri: model.uri.toString() },
        range: toLspRange(range),
        context: {
          diagnostics: [],
          only: context.only ? [context.only] : undefined,
        },
      });

      const actions: MonacoType.languages.CodeAction[] = (result ?? []).map((action) => {
        const command = typeof action.command === "object" ? action.command : undefined;
        return {
          title: action.title,
          kind: action.kind,
          isPreferred: action.isPreferred,
          edit: action.edit ? toMonacoWorkspaceEdit(monaco, action.edit) : undefined,
          // A command-only action does its work on the server, so it is
          // forwarded rather than turned into an edit.
          command: command && executeCommandId
            ? { id: executeCommandId, title: command.title, arguments: [{ model, command: command.command, arguments: command.arguments }] }
            : undefined,
        };
      });

      return { actions, dispose: () => {} };
    },
  });

  monaco.languages.registerInlayHintsProvider(language, {
    async provideInlayHints(model, range) {
      const document = lspDocumentFor(model);
      if (!document || !supports(document, "inlayHintProvider")) return { hints: [], dispose: () => {} };
      const result = await ask<Array<{ position: { line: number; character: number }; label: string | Array<{ value: string }>; kind?: number; paddingLeft?: boolean; paddingRight?: boolean }>>(
        document,
        "textDocument/inlayHint",
        { textDocument: { uri: model.uri.toString() }, range: toLspRange(range) },
      );
      return {
        hints: (result ?? []).map((hint) => ({
          position: { lineNumber: hint.position.line + 1, column: hint.position.character + 1 },
          label: typeof hint.label === "string" ? hint.label : hint.label.map((part) => part.value).join(""),
          kind: hint.kind === 1 ? monaco.languages.InlayHintKind.Type : monaco.languages.InlayHintKind.Parameter,
          paddingLeft: hint.paddingLeft,
          paddingRight: hint.paddingRight,
        })),
        dispose: () => {},
      };
    },
  });
}

function emptyRangeAt(position: MonacoType.IPosition): MonacoType.IRange {
  return {
    startLineNumber: position.lineNumber, startColumn: position.column,
    endLineNumber: position.lineNumber, endColumn: position.column,
  };
}
