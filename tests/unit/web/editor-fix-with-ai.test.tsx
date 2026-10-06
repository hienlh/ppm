import { afterAll, expect, it } from "bun:test";
import { installDom, uninstallDom, mount } from "../../helpers/react-dom";
installDom();
afterAll(() => uninstallDom());
const { EditorFixWithAi, readProblemsContext, ASK_AI_COMMAND } =
  await import("../../../src/web/components/editor/editor-fix-with-ai");
const { SEND_TO_CHAT_EVENT, SEND_TO_CHAT_ACK_EVENT } = await import("../../../src/web/lib/send-to-chat");
const { usePanelStore } = await import("../../../src/web/stores/panel-store");

const Severity = { Hint: 1, Info: 2, Warning: 4, Error: 8 } as const;
const FILE = ["import x from './x';", "", "const answer = 42;", "console.log(answe);", "", "function demo() {", "  return answer;", "}", "", "export {};"];

/** Whole lines, which is all the problems' context ever asks for. */
const fakeModel = (lines: string[]) => ({
  getLineCount: () => lines.length,
  getLineMaxColumn: (line: number) => lines[line - 1]!.length + 1,
  getValueInRange: (r: { startLineNumber: number; endLineNumber: number }) => lines.slice(r.startLineNumber - 1, r.endLineNumber).join("\n"),
  getLanguageId: () => "typescript",
}) as any;

const marker = (line: number, column: number, severity: number, message: string, extra: object = {}) =>
  ({ startLineNumber: line, startColumn: column, endLineNumber: line, endColumn: column + 5, severity, message, ...extra });

it("lists the errors and warnings it was handed, and quotes the code around them as the editor has it", () => {
  const context = readProblemsContext(fakeModel(FILE), [
    marker(4, 13, Severity.Error, "Cannot find name 'answe'. Did you mean 'answer'?", { source: "typescript", code: "2552" }),
    marker(1, 8, Severity.Warning, "'x' is declared but its value is never read.", { source: "typescript", code: { value: "6133", target: {} } }),
    marker(7, 3, Severity.Hint, "This may be converted to an arrow function."),
  ], "src/example.ts", Severity as any)!;

  // In file order, whatever order the owners published them in.
  expect(context.markers.map((m: any) => m.startLineNumber)).toEqual([1, 4]);
  expect(context.label).toBe("Problems in src/example.ts:1");
  const body = [
    "- 1:8 warning: 'x' is declared but its value is never read. typescript(6133)",
    "- 4:13 error: Cannot find name 'answe'. Did you mean 'answer'? typescript(2552)",
    "",
    // Three lines either side of lines 1-4, clamped to the file.
    "Code from src/example.ts:1-7",
    "```typescript",
    ...FILE.slice(0, 7),
    "```",
  ];
  expect(context.fix).toBe(["Fix these problems in src/example.ts:", ...body].join("\n"));
  // The same problems and code; only what is asked of them differs.
  expect(context.explain).toBe(["Explain these problems in src/example.ts, without changing any files:", ...body].join("\n"));
});

it("keeps a multi-line message inside its bullet and says 'this problem' for one", () => {
  const context = readProblemsContext(fakeModel(FILE), [
    marker(10, 1, Severity.Error, "Type 'string' is not assignable to type 'number'.\n  'a' is missing."),
  ], "a.ts", Severity as any)!;
  expect(context.fix.split("\n").slice(0, 3)).toEqual([
    "Fix this problem in a.ts:",
    "- 10:1 error: Type 'string' is not assignable to type 'number'.",
    "    'a' is missing.",
  ]);
  expect(context.fix).toContain("Code from a.ts:7-10\n");
  expect(context.explain.split("\n")[0]).toBe("Explain this problem in a.ts, without changing any files:");
});

it("offers nothing for hints and infos alone", () => {
  expect(readProblemsContext(fakeModel(FILE), [marker(7, 3, Severity.Hint, "hint"), marker(7, 3, Severity.Info, "info")], "a.ts", Severity as any)).toBeNull();
  expect(readProblemsContext(fakeModel(FILE), [], "a.ts", Severity as any)).toBeNull();
});

it("offers Fix and Explain as AI quick fixes on its own editor's problems, each sending its request from a new chat", async () => {
  let provider: any;
  const commands = new Map<string, (accessor: unknown, ...args: any[]) => void>();
  const disposed: string[] = [];
  const monaco = {
    MarkerSeverity: Severity,
    languages: {
      registerCodeActionProvider: (_languages: unknown, value: unknown) => {
        provider = value;
        return { dispose: () => disposed.push("provider") };
      },
    },
    editor: {
      registerCommand: (id: string, handler: (accessor: unknown, ...args: any[]) => void) => {
        commands.set(id, handler);
        return { dispose: () => disposed.push("command") };
      },
    },
  } as any;
  const model = fakeModel(FILE);
  const editor = { getModel: () => model } as any;
  const original = usePanelStore.getState();
  const opened: any[] = [];
  usePanelStore.setState({ openTab: ((tab: any) => { opened.push(tab); return `chat:new-${opened.length}`; }) as any });
  const sent: any[] = [];
  const composer = (e: Event) => {
    sent.push((e as CustomEvent).detail);
    window.dispatchEvent(new CustomEvent(SEND_TO_CHAT_ACK_EVENT, { detail: { sent: true } }));
  };
  window.addEventListener(SEND_TO_CHAT_EVENT, composer);
  const view = await mount(<EditorFixWithAi editor={editor} monaco={monaco} filePath="src/example.ts" projectName="demo" />);
  try {
    const error = marker(4, 13, Severity.Error, "Cannot find name 'answe'.");
    const list = provider.provideCodeActions(model, error, { markers: [error, marker(7, 3, Severity.Hint, "hint")] });
    // Fix first: Monaco's problem hover shows only the first AI action.
    expect(list.actions.map((a: any) => a.title)).toEqual(["Fix with AI", "Explain with AI"]);
    for (const action of list.actions) {
      // `isAI` is what makes Monaco draw the sparkle, and put the action in the problem's hover —
      // which asks for quick fixes only.
      expect(action).toMatchObject({ kind: "quickfix", isAI: true, diagnostics: [error] });
      expect(action.command.id).toBe(ASK_AI_COMMAND);
    }
    // Another editor's model, or nothing worth fixing: no action.
    expect(provider.provideCodeActions(fakeModel(FILE), error, { markers: [error] })).toBeUndefined();
    expect(provider.provideCodeActions(model, error, { markers: [] })).toBeUndefined();

    for (const action of list.actions) commands.get(action.command.id)!(undefined, ...action.command.arguments);
    expect(opened).toHaveLength(2);
    // No draft: the new chat's composer sends the request itself.
    expect(opened.map((tab) => tab.metadata)).toEqual([{ projectName: "demo" }, { projectName: "demo" }]);
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({ targetTabId: "chat:new-1", autoSend: true });
    expect(sent[0].text).toStartWith("Fix this problem in src/example.ts:\n- 4:13 error: Cannot find name 'answe'.");
    expect(sent[1]).toMatchObject({ targetTabId: "chat:new-2", autoSend: true });
    expect(sent[1].text).toStartWith("Explain this problem in src/example.ts, without changing any files:\n- 4:13 error: Cannot find name 'answe'.");
  } finally {
    await view.unmount();
    window.removeEventListener(SEND_TO_CHAT_EVENT, composer);
    usePanelStore.setState({ openTab: original.openTab });
  }
  expect(disposed.sort()).toEqual(["command", "provider"]);
});
