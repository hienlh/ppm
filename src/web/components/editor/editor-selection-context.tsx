import { useEffect } from "react";
import type * as Monaco from "monaco-editor";
import { sendToChat } from "@/lib/send-to-chat";
import { codeFence } from "@/lib/code-fence";

/** Global to the page, like every command in Monaco's standalone registry. */
export const ADD_SELECTION_TO_CHAT_COMMAND = "ppm.selection.addToChat";

const CHAT_TARGETS = [
  { title: "Add to current chat", newTab: false },
  { title: "Add to new chat", newTab: true },
] as const;

type SelectionChatRequest = { text: string; label: string; projectName?: string; newTab: boolean };

export function readSelectionContext(model: Monaco.editor.ITextModel, range: Monaco.IRange, filePath: string) {
  if (range.startLineNumber === range.endLineNumber && range.startColumn === range.endColumn) return null;
  const text = model.getValueInRange(range);
  if (!text.trim()) return null;
  const endLine = range.endColumn === 1 && range.endLineNumber > range.startLineNumber
    ? range.endLineNumber - 1 : range.endLineNumber;
  const label = `${filePath}:${range.startLineNumber}${endLine === range.startLineNumber ? "" : `-${endLine}`}`;
  const fence = codeFence(text);
  return { label, text: `Selected code from ${label}\n${fence}${model.getLanguageId()}\n${text}\n${fence}` };
}

/**
 * Offers the selection to chat as two code actions, so they appear under Monaco's
 * own lightbulb, in Monaco's own menu, beside whatever a language server offers.
 * Nothing is drawn here: where the bulb goes (on the line, or in the glyph margin
 * left of the line numbers when the line has no room) is Monaco's decision.
 */
export function EditorSelectionContext({ editor, monaco, filePath, projectName }: {
  editor: Monaco.editor.IStandaloneCodeEditor;
  monaco: typeof Monaco;
  filePath: string;
  projectName?: string;
}) {
  useEffect(() => {
    // Registered by every mounted editor under one id: the registry stacks them,
    // so closing one editor leaves the command to the others.
    const command = monaco.editor.registerCommand(ADD_SELECTION_TO_CHAT_COMMAND,
      (_accessor, request: SelectionChatRequest) => sendToChat({ ...request, asContext: true }));
    const provider = monaco.languages.registerCodeActionProvider("*", {
      provideCodeActions(model, range) {
        // Providers are global too; this one answers only for its own editor.
        if (model !== editor.getModel()) return undefined;
        // Snapshot now: the menu's range is the one the bulb was shown for.
        const context = readSelectionContext(model, range, filePath);
        if (!context) return undefined;
        return {
          actions: CHAT_TARGETS.map(({ title, newTab }) => ({
            title,
            command: {
              id: ADD_SELECTION_TO_CHAT_COMMAND,
              title,
              arguments: [{ ...context, projectName, newTab } satisfies SelectionChatRequest],
            },
          })),
          dispose() {},
        };
      },
    });
    return () => {
      provider.dispose();
      command.dispose();
    };
  }, [editor, monaco, filePath, projectName]);
  return null;
}
