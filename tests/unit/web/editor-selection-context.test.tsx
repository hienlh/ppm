import { afterAll, expect, it } from "bun:test";
import { installDom, uninstallDom, mount } from "../../helpers/react-dom";
installDom();
afterAll(() => uninstallDom());
const { EditorSelectionContext, readSelectionContext, ADD_SELECTION_TO_CHAT_COMMAND } =
  await import("../../../src/web/components/editor/editor-selection-context");
const { usePanelStore } = await import("../../../src/web/stores/panel-store");

const range = (startLineNumber: number, startColumn: number, endLineNumber: number, endColumn: number) =>
  ({ startLineNumber, startColumn, endLineNumber, endColumn });
const fakeModel = (text: string) => ({ getValueInRange: () => text, getLanguageId: () => "typescript" }) as any;

it("quotes exact selected code and excludes the unselected next line", () => {
  const context = readSelectionContext(fakeModel("const fence = '```';\n"), range(2, 1, 3, 1), "src/example.ts")!;
  expect(context.label).toBe("src/example.ts:2");
  expect(context.text).toContain("````typescript\nconst fence = '```';\n\n````");
  expect(readSelectionContext(fakeModel("  "), range(2, 1, 3, 1), "x.ts")).toBeNull();
  expect(readSelectionContext(fakeModel("x"), range(2, 4, 2, 4), "x.ts")).toBeNull();
});

it("sizes the fence for a selection with more backtick runs than a call takes arguments", () => {
  // Chrome's V8 throws a RangeError for a spread of ~200k arguments; Bun's JSC
  // does not, so the browser's limit is imposed here or the test proves nothing.
  const realMax = Math.max;
  Math.max = (...values: number[]) => {
    if (values.length > 100_000) throw new RangeError("Maximum call stack size exceeded");
    return realMax(...values);
  };
  try {
    const context = readSelectionContext(fakeModel("`a` ".repeat(150_000) + "`````"), range(1, 1, 1, 9), "big.md")!;
    expect(context.text).toContain("\n``````typescript\n");
  } finally {
    Math.max = realMax;
  }
});

it("offers both chats as code actions on its own editor's selection, and the action adds a chip", async () => {
  let selector: unknown;
  let provider: any;
  const commands = new Map<string, (accessor: unknown, ...args: any[]) => void>();
  const disposed: string[] = [];
  const monaco = {
    languages: {
      registerCodeActionProvider: (languages: unknown, value: unknown) => {
        selector = languages;
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
  const model = fakeModel("const answer = 42;\n");
  const editor = { getModel: () => model } as any;
  const original = usePanelStore.getState();
  const opened: any[] = [];
  usePanelStore.setState({ openTab: ((tab: any) => { opened.push(tab); return "new"; }) as any });
  const view = await mount(<EditorSelectionContext editor={editor} monaco={monaco} filePath="src/example.ts" projectName="demo" />);
  try {
    // Every language, so the bulb is there whatever the file is.
    expect(selector).toBe("*");
    const list = provider.provideCodeActions(model, range(2, 1, 3, 1));
    expect(list.actions.map((action: any) => action.title)).toEqual(["Add to current chat", "Add to new chat"]);
    expect(list.actions.every((action: any) => action.command.id === ADD_SELECTION_TO_CHAT_COMMAND)).toBe(true);
    // Another editor's model, an empty selection: nothing to offer.
    expect(provider.provideCodeActions(fakeModel("const answer = 42;\n"), range(2, 1, 3, 1))).toBeUndefined();
    expect(provider.provideCodeActions(model, range(2, 5, 2, 5))).toBeUndefined();
    // Choosing the action is Monaco running the command with the action's arguments.
    const addToNewChat = list.actions[1].command;
    commands.get(addToNewChat.id)!(undefined, ...addToNewChat.arguments);
    expect(opened[0].metadata.projectName).toBe("demo");
    expect(opened[0].metadata.pendingContexts[0].label).toBe("src/example.ts:2");
    expect(opened[0].metadata.pendingContexts[0].text).toContain("const answer = 42;");
    expect(opened[0].metadata.pendingMessage).toBeUndefined();
  } finally {
    await view.unmount();
    usePanelStore.setState({ openTab: original.openTab });
  }
  expect(disposed.sort()).toEqual(["command", "provider"]);
});
