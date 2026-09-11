/**
 * The language-server integration, in a chunk nothing downloads until it is on.
 *
 * Everything LSP hangs off this one component: the WebSocket to the host, the
 * Monaco providers, the semantic-token legend, the F12 binding. `code-editor`
 * mounts it through `lazy()` and only while the setting is on, which buys two
 * different things. The small one is bundle weight — the client, the providers
 * and the conversions are no longer in the chunk that opening a file pulls in.
 * The large one is that nothing asks the host for a server, so no server is
 * spawned: one `typescript-language-server` on one project was 854 MB resident.
 *
 * It renders nothing. Status and diagnostics are handed back up to the editor,
 * which owns the toolbar row they are drawn in — so unmounting this takes the
 * indicator with it instead of leaving a stale one claiming a server is ready.
 */
import { useEffect, useRef } from "react";
import type * as MonacoType from "monaco-editor";
import { useLsp, type LspDiagnostic } from "@/hooks/use-lsp";
import { registerLspNavigation } from "@/lib/lsp/lsp-navigation";
import type { LspDocumentStatus } from "@/lib/lsp/lsp-client";
import { useTabStore } from "@/stores/tab-store";

export interface EditorLspState {
  status: LspDocumentStatus | null;
  diagnostics: LspDiagnostic[];
}

const NO_LSP_STATE: EditorLspState = { status: null, diagnostics: [] };

interface EditorLanguageServiceProps {
  editor: MonacoType.editor.IStandaloneCodeEditor;
  monaco: typeof MonacoType;
  projectName: string;
  /** Project-relative path. The caller has already checked a server could serve it. */
  filePath: string;
  onState: (state: EditorLspState) => void;
}

export function EditorLanguageService({
  editor, monaco, projectName, filePath, onState,
}: EditorLanguageServiceProps) {
  const { status, diagnostics } = useLsp({ editor, monaco, projectName, filePath, enabled: true });

  // F12. Monaco's own binding would swap another file's model into this
  // editor, leaving the tab titled and dirty-tracked as the old file. Disposed
  // on the way out, so turning the setting off gives Monaco's binding back.
  useEffect(() => {
    const action = registerLspNavigation(monaco, editor, {
      openFileTab: (path, project, line) =>
        useTabStore.getState().openTab({
          type: "editor",
          title: path.split("/").pop() || path,
          projectId: project,
          metadata: { filePath: path, projectName: project, lineNumber: line },
          closable: true,
        }),
    });
    return () => action.dispose();
  }, [monaco, editor]);

  // Through a ref so a caller passing a fresh closure each render does not
  // re-publish on every render of the editor above.
  const onStateRef = useRef(onState);
  onStateRef.current = onState;

  useEffect(() => {
    onStateRef.current({ status, diagnostics });
  }, [status, diagnostics]);

  // The editor keeps drawing whatever it was last told, so a language service
  // that is going away has to retract its own status.
  useEffect(() => () => onStateRef.current(NO_LSP_STATE), []);

  return null;
}

export default EditorLanguageService;
