import { useEffect } from "react";
import type * as Monaco from "monaco-editor";
import { sendToChat } from "@/lib/send-to-chat";
import { codeFence } from "@/lib/code-fence";

/** Global to the page, like every command in Monaco's standalone registry. */
export const ASK_AI_COMMAND = "ppm.problems.askAi";

/** Lines quoted either side of the problems, so the request reads on its own in the transcript. */
const CONTEXT_LINES = 3;

type AskRequest = { text: string; label: string; projectName?: string };

/**
 * The requests "Fix with AI" and "Explain with AI" send: the errors and warnings among the
 * markers Monaco handed the provider (those touching the range the bulb or the hover is for), and
 * the code around them as the editor has it. Hints and infos are nothing anyone asked to have
 * fixed, and Copilot leaves them out too.
 */
export function readProblemsContext(
  model: Monaco.editor.ITextModel,
  markers: Monaco.editor.IMarkerData[],
  filePath: string,
  severity: typeof Monaco.MarkerSeverity,
) {
  const problems = markers
    .filter((marker) => marker.severity >= severity.Warning)
    // Monaco hands them over by owner, then as each owner published them; the reader wants file order.
    .sort((a, b) => a.startLineNumber - b.startLineNumber || a.startColumn - b.startColumn);
  if (problems.length === 0) return null;
  let first = Infinity;
  let last = 0;
  for (const marker of problems) {
    first = Math.min(first, marker.startLineNumber);
    last = Math.max(last, marker.endLineNumber);
  }
  const from = Math.max(1, first - CONTEXT_LINES);
  const to = Math.min(model.getLineCount(), last + CONTEXT_LINES);
  const code = model.getValueInRange({ startLineNumber: from, startColumn: 1, endLineNumber: to, endColumn: model.getLineMaxColumn(to) });
  const fence = codeFence(code);
  const list = problems.map((marker) => {
    const id = typeof marker.code === "string" ? marker.code : marker.code?.value;
    const tag = `${marker.source ?? ""}${id ? `(${id})` : ""}`;
    const kind = marker.severity === severity.Error ? "error" : "warning";
    // A multi-line message (a type mismatch's elaboration) stays inside its bullet.
    return `- ${marker.startLineNumber}:${marker.startColumn} ${kind}: ${marker.message.replace(/\n/g, "\n  ")}${tag ? ` ${tag}` : ""}`;
  });
  const body = [...list, "", `Code from ${filePath}:${from}-${to}`, `${fence}${model.getLanguageId()}`, code, fence];
  const these = problems.length === 1 ? "this problem" : "these problems";
  return {
    markers: problems,
    label: `Problems in ${filePath}:${first}`,
    fix: [`Fix ${these} in ${filePath}:`, ...body].join("\n"),
    // Said outright: the chat it lands in may edit files, and an explanation is all that was asked for.
    explain: [`Explain ${these} in ${filePath}, without changing any files:`, ...body].join("\n"),
  };
}

/**
 * "Fix with AI" and "Explain with AI" on every error and warning, Copilot's pair (Cursor has the
 * first as Fix in Chat). Both are quick fixes flagged `isAI`, so Monaco does the rest: a sparkle
 * beside each in its own menu, the first as a one-click action in the problem's hover — Monaco
 * shows one there, which is why Fix is listed first — and a sparkle for the bulb. Monaco would run
 * a lone AI action straight from the bulb; with two on offer the bulb opens its menu, as VS Code's
 * does with Copilot's.
 *
 * Each request opens a new chat and is sent at once, as Cursor's is: the turn is the whole point,
 * and a fresh conversation keeps it out of whatever the selected chat is about.
 */
export function EditorFixWithAi({ editor, monaco, filePath, projectName }: {
  editor: Monaco.editor.IStandaloneCodeEditor;
  monaco: typeof Monaco;
  filePath: string;
  projectName?: string;
}) {
  useEffect(() => {
    // Registered by every mounted editor under one id: the registry stacks them,
    // so closing one editor leaves the command to the others.
    const command = monaco.editor.registerCommand(ASK_AI_COMMAND,
      (_accessor, request: AskRequest) => sendToChat({ ...request, newTab: true, autoSend: true }));
    const provider = monaco.languages.registerCodeActionProvider("*", {
      provideCodeActions(model, _range, context) {
        // Providers are global too; this one answers only for its own editor.
        if (model !== editor.getModel()) return undefined;
        // Snapshot now: the request describes the problems the action was offered for.
        const problems = readProblemsContext(model, context.markers, filePath, monaco.MarkerSeverity);
        if (!problems) return undefined;
        const asks = [["Fix with AI", problems.fix], ["Explain with AI", problems.explain]] as const;
        return {
          actions: asks.map(([title, text]) => ({
            title,
            kind: "quickfix",
            isAI: true,
            diagnostics: problems.markers,
            command: {
              id: ASK_AI_COMMAND,
              title,
              arguments: [{ text, label: problems.label, projectName } satisfies AskRequest],
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
