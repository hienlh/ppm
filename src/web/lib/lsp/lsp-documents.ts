/**
 * Which language-server document a Monaco model belongs to.
 *
 * Monaco hands a provider a model, not a project or a path, so this is the only
 * way a provider registered globally for "typescript" can tell whose file it is
 * being asked about. Keyed by the model's URI string because that is what the
 * provider has in hand, and because two tabs on the same file share one model.
 *
 * A model that is not registered here has no language server, and every
 * provider returns nothing for it rather than guessing — an untitled buffer, a
 * diff pane, or a file in a project whose socket has not connected yet.
 */
import type * as MonacoType from "monaco-editor";
import type { LspConnection } from "./lsp-client";

export interface LspDocument {
  connection: LspConnection;
  /** Project-relative path, which is what the bridge expects. */
  path: string;
}

const documents = new Map<string, LspDocument>();

export function registerLspDocument(model: MonacoType.editor.ITextModel, document: LspDocument): void {
  documents.set(model.uri.toString(), document);
}

export function unregisterLspDocument(model: MonacoType.editor.ITextModel): void {
  documents.delete(model.uri.toString());
}

export function lspDocumentFor(model: MonacoType.editor.ITextModel): LspDocument | undefined {
  return documents.get(model.uri.toString());
}

/** The document behind a `file:` URI a server reported, for cross-file results. */
export function lspDocumentForUri(uri: string): LspDocument | undefined {
  return documents.get(uri);
}
