/**
 * Connects one Monaco editor to the language server for its file.
 *
 * Registers the model as a document, keeps the server's copy in step with the
 * buffer, turns published diagnostics into markers, and reports the server's
 * state so the UI can say what is happening.
 *
 * Edits are sent incrementally, which is what VS Code does and what keeps a
 * large file affordable. Monaco hands out changes already ordered bottom-up
 * within an event, which is the order LSP needs for sequential application, so
 * they pass straight through. The version number is the safety net: if it ever
 * skips, the bridge asks for the whole document back rather than applying a
 * delta to a copy that is already wrong.
 */
import { useEffect, useRef, useState } from "react";
import type * as MonacoType from "monaco-editor";
import {
  acquireLspConnection,
  releaseLspConnection,
  type LspConnection,
  type LspDocumentStatus,
} from "@/lib/lsp/lsp-client";
import { registerLspDocument, unregisterLspDocument } from "@/lib/lsp/lsp-documents";
import { registerLspProviders } from "@/lib/lsp/register-providers";
import { fromLspRange, markerSeverity } from "@/lib/lsp/lsp-monaco";
import { registerSemanticTokens, semanticTokensLegendOf } from "@/lib/lsp/lsp-semantic-tokens";
import { useProblemsStore } from "@/stores/problems-store";

export interface UseLspOptions {
  editor: MonacoType.editor.IStandaloneCodeEditor | null;
  monaco: typeof MonacoType | null;
  projectName?: string;
  /** Project-relative path. An absolute or untitled path is not served. */
  filePath?: string;
  enabled: boolean;
}

export interface LspState {
  status: LspDocumentStatus | null;
  /** Diagnostics for this file, for a Problems view to list. */
  diagnostics: LspDiagnostic[];
}

export interface LspDiagnostic {
  message: string;
  severity?: number;
  source?: string;
  code?: string | number;
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
}

/**
 * Markers are owned per language server so clearing one server's diagnostics
 * cannot wipe another's — PPM's own SQL and JSON markers live on the same
 * models.
 */
const MARKER_OWNER = "ppm-lsp";

export function useLsp({ editor, monaco, projectName, filePath, enabled }: UseLspOptions): LspState {
  const [status, setStatus] = useState<LspDocumentStatus | null>(null);
  const [diagnostics, setDiagnostics] = useState<LspDiagnostic[]>([]);
  const connectionRef = useRef<LspConnection | null>(null);

  const active = enabled && Boolean(projectName && filePath && editor && monaco);

  // Register the providers once Monaco exists. Doing it here rather than at
  // module load keeps it out of the bundle's startup path, and the function
  // itself is idempotent per language.
  useEffect(() => {
    if (!monaco || !active) return;
    registerLspProviders(monaco);
  }, [monaco, active]);

  // Open the document, keep it in step, and close it on the way out.
  useEffect(() => {
    if (!active || !editor || !monaco || !projectName || !filePath) {
      setStatus(null);
      setDiagnostics([]);
      return;
    }

    const model = editor.getModel();
    if (!model) return;

    const connection = acquireLspConnection(projectName);
    connectionRef.current = connection;
    registerLspDocument(model, { connection, path: filePath });

    const offStatus = connection.onStatus((path, next) => {
      if (path !== filePath) return;
      setStatus(next);
      // Semantic tokens are indices into a legend only the server knows, so the
      // provider cannot be registered until one has answered. Idempotent per
      // language, so every editor mount arriving here costs nothing.
      if (next.state === "ready") {
        const legend = semanticTokensLegendOf(next.capabilities);
        if (legend) registerSemanticTokens(monaco, model.getLanguageId(), legend);
      }
    });

    const offNotification = connection.onNotification((method, params) => {
      if (method !== "textDocument/publishDiagnostics") return;
      const payload = params as { uri?: string; diagnostics?: LspDiagnostic[] };
      // The bridge rewrote the URI to this model's, so a mismatch means the
      // diagnostics belong to a different file this socket also has open.
      if (payload.uri !== model.uri.toString()) return;

      const list = payload.diagnostics ?? [];
      setDiagnostics(list);
      // Also to the shared store, which is what the Problems panel reads. The
      // markers below only draw on this model, so they can say what is wrong
      // with *this* file and nothing more.
      useProblemsStore.getState().publish(projectName, filePath, list);
      monaco.editor.setModelMarkers(
        model,
        MARKER_OWNER,
        list.map((diagnostic) => ({
          ...fromLspRange(diagnostic.range),
          message: diagnostic.message,
          severity: markerSeverity(monaco, diagnostic.severity),
          source: diagnostic.source,
          code: diagnostic.code === undefined ? undefined : String(diagnostic.code),
        })),
      );
    });

    connection.open(filePath, {
      getText: () => model.getValue(),
      getVersion: () => model.getVersionId(),
      clientUri: model.uri.toString(),
    });

    const onChange = model.onDidChangeContent((event) => {
      connection.change(
        filePath,
        event.versionId,
        // Monaco's ranges are 1-based and its changes within one event are
        // already ordered bottom-up, which is the order LSP applies them in.
        event.changes.map((change) => ({
          range: {
            start: { line: change.range.startLineNumber - 1, character: change.range.startColumn - 1 },
            end: { line: change.range.endLineNumber - 1, character: change.range.endColumn - 1 },
          },
          text: change.text,
        })),
      );
    });

    return () => {
      onChange.dispose();
      offStatus();
      offNotification();
      // Clear our markers so a closed file's errors do not outlive it.
      monaco.editor.setModelMarkers(model, MARKER_OWNER, []);
      useProblemsStore.getState().clear(projectName, filePath);
      unregisterLspDocument(model);
      connection.close(filePath);
      releaseLspConnection(projectName);
      connectionRef.current = null;
      setStatus(null);
      setDiagnostics([]);
    };
  }, [active, editor, monaco, projectName, filePath]);

  return { status, diagnostics };
}

/** Tell the server a save happened, so servers that only analyse on save catch up. */
export function notifyLspSave(projectName: string, filePath: string, text: string): void {
  // Uses the shared connection rather than a hook, because a save comes from
  // the toolbar and the keybinding as well as from the editor.
  const connection = acquireLspConnection(projectName);
  try {
    connection.save(filePath, text);
  } finally {
    releaseLspConnection(projectName);
  }
}
