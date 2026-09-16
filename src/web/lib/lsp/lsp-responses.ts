/**
 * The shapes a language server answers with, turned into the shapes Monaco wants.
 *
 * Split out of `register-providers.ts`, which was doing two jobs at 673 lines: deciding what
 * to ask and translating what came back. These are the second job — one level above
 * `lsp-monaco.ts`, which handles the primitives (positions, kinds, markdown, one edit) with no
 * Monaco instance at all. Everything here needs `monaco` itself, for `Uri.parse` and the enum
 * values, and one of them needs the network, for the models a cross-file result names.
 */
import type * as MonacoType from "monaco-editor";
import type { LspDocument } from "./lsp-documents";
import { ensureShadowModels } from "./lsp-shadow-models";
import {
  completionKind,
  fromLspRange,
  symbolKind,
  toMarkdown,
  type LspMarkup,
  type LspRange,
  type LspTextEdit,
} from "./lsp-monaco";

// ── Shapes a server can answer with ────────────────────────────────────────

export interface LspLocation {
  uri: string;
  range: LspRange;
}

export interface LspLocationLink {
  targetUri: string;
  targetSelectionRange?: LspRange;
  targetRange: LspRange;
}

export interface LspCompletionItem {
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

export interface LspDocumentSymbol {
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

export interface LspWorkspaceEdit {
  changes?: Record<string, LspTextEdit[]>;
  documentChanges?: Array<{ textDocument: { uri: string; version?: number }; edits: LspTextEdit[] }>;
}

/**
 * What a suggestion has to carry to be resolvable.
 *
 * The document itself, not its path: a path is project-relative, and two projects open on
 * `src/index.ts` are two different files on two different servers. Looking the model back up
 * by path found whichever of them Monaco listed first, so resolving a suggestion could ask the
 * wrong project's server — for a completion item it has never issued.
 */
export type ResolvableItem = MonacoType.languages.CompletionItem & {
  __lsp?: LspCompletionItem;
  __document?: LspDocument;
};

// ── Conversions that need Monaco ───────────────────────────────────────────

export function toMonacoLocations(
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
export async function toResolvableLocations(
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

export function toMonacoWorkspaceEdit(
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

export function toMonacoCompletion(
  monaco: typeof MonacoType,
  model: MonacoType.editor.ITextModel,
  position: MonacoType.IPosition,
  item: LspCompletionItem,
  document: LspDocument,
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
    __document: document,
  };

  // 2 = Snippet. Without this rule the placeholders arrive as literal `${1:x}`.
  if (item.insertTextFormat === 2) {
    converted.insertTextRules = monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet;
  }
  return converted;
}

export function toMonacoSymbols(
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
