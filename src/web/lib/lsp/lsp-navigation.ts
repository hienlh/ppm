/**
 * Go to definition across files.
 *
 * Monaco's own F12 is left in place for everything that stays inside the open
 * file, but a target in *another* file cannot be. Standalone Monaco resolves it
 * through its default editor service, which — once a model exists for the
 * target — swaps that model into the current editor. The tab keeps its old
 * title and its old file's dirty state while showing different contents, which
 * is worse than the feature not working.
 *
 * So this replaces the F12 binding with one that asks the server directly and
 * routes the answer: reveal it here if it is here, and otherwise open the file
 * as its own tab, positioned on the definition.
 *
 * Peek (Alt+F12) and find-all-references (Shift+F12) keep Monaco's bindings,
 * because those render in place and never navigate — they need a resolvable
 * model, which `lsp-shadow-models.ts` provides, but no interception.
 */
import type * as MonacoType from "monaco-editor";
import { lspDocumentFor } from "./lsp-documents";
import { fromLspPosition, toLspPosition, type LspRange } from "./lsp-monaco";
import { fileUriToPath } from "../../../shared/lsp-uri";

interface LspLocation {
  uri: string;
  range: LspRange;
}

interface LspLocationLink {
  targetUri: string;
  targetRange: LspRange;
  targetSelectionRange?: LspRange;
}

export interface NavigationHost {
  /**
   * Open a project file positioned on a line.
   *
   * Line only, not line and column: `metadata.lineNumber` is the convention
   * PPM's tabs already use for the search panel and chat `file:line` links, and
   * a second reveal mechanism alongside it would be worse than losing the
   * column.
   */
  openFileTab: (path: string, projectName: string, lineNumber: number) => void;
}

/**
 * Bind F12 on this editor.
 *
 * `addAction` registers into the editor's own action set, which takes
 * precedence over the built-in contribution, so this replaces rather than
 * competes with Monaco's binding.
 */
export function registerLspNavigation(
  monaco: typeof MonacoType,
  editor: MonacoType.editor.IStandaloneCodeEditor,
  host: NavigationHost,
): MonacoType.IDisposable {
  return editor.addAction({
    id: "ppm.lsp.goToDefinition",
    label: "Go to Definition",
    keybindings: [monaco.KeyCode.F12],
    contextMenuGroupId: "navigation",
    contextMenuOrder: 1.1,
    run: async (ed) => {
      const model = ed.getModel();
      const position = ed.getPosition();
      if (!model || !position) return;

      const document = lspDocumentFor(model);
      if (!document) return;

      let result: LspLocation | LspLocation[] | LspLocationLink[] | null = null;
      try {
        result = await document.connection.request(document.path, "textDocument/definition", {
          textDocument: { uri: model.uri.toString() },
          position: toLspPosition(position),
        });
      } catch {
        // No server, or it declined. Nothing to navigate to, and an error
        // dialog for a keypress would be worse than silence.
        return;
      }

      const first = (Array.isArray(result) ? result[0] : result) ?? null;
      if (!first) return;

      const uri = "targetUri" in first ? first.targetUri : first.uri;
      const range = "targetUri" in first ? (first.targetSelectionRange ?? first.targetRange) : first.range;
      if (!uri || !range) return;

      const target = fromLspPosition(range.start);

      // The bridge rewrites a URI in the open file to the model's own, so this
      // comparison is how "same file" is detected.
      if (uri === model.uri.toString()) {
        ed.setPosition(target);
        ed.revealPositionInCenterIfOutsideViewport(target, monaco.editor.ScrollType.Smooth);
        // Matches what VS Code does on a jump within a file.
        ed.setSelection({
          startLineNumber: target.lineNumber,
          startColumn: target.column,
          endLineNumber: range.end.line + 1,
          endColumn: range.end.character + 1,
        });
        return;
      }

      const status = document.connection.statusOf(document.path);
      if (status?.state !== "ready" || !status.projectPath) return;

      const absolute = fileUriToPath(uri);
      if (!absolute) return; // a virtual document, with no file to open
      const relative = relativeTo(status.projectPath, absolute);
      // Outside the project — a definition in node_modules or a toolchain
      // library. PPM's tabs are project-scoped, so there is nowhere to put it.
      if (!relative) return;

      host.openFileTab(relative, document.connection.projectName, target.lineNumber);
    },
  });
}

function relativeTo(projectPath: string, absolute: string): string | null {
  const root = projectPath.replace(/\\/g, "/").replace(/\/+$/, "");
  const path = absolute.replace(/\\/g, "/");
  if (!path.startsWith(root + "/")) return null;
  return path.slice(root.length + 1);
}
