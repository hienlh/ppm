/**
 * The device half of the Assistant's command tools: it lists the registry as this device sees
 * it, runs only ids the registry offers, and will not run a command that changes data unless the
 * server attached the user's approval for that very command.
 */
import { afterAll, afterEach, describe, expect, it, spyOn } from "bun:test";
import { installDom, uninstallDom } from "../../helpers/react-dom";

installDom();
const { answerAssistantUi } = await import("../../../src/web/lib/assistant-ui/answer-assistant-ui");
const { useTabStore } = await import("../../../src/web/stores/tab-store");
const { useProjectStore } = await import("../../../src/web/stores/project-store");
const { useSettingsStore } = await import("../../../src/web/stores/settings-store");
const { useExtensionStore } = await import("../../../src/web/stores/extension-store");

const settingsBefore = useSettingsStore.getState();
afterAll(uninstallDom);
afterEach(() => {
  useProjectStore.setState({ activeProject: null });
  useExtensionStore.setState({ contributions: null });
  useSettingsStore.setState(settingsBefore, true);
});

const ID = "AbCdEfGhIjKlMnOp";

async function ask(op: "list_commands" | "run_command", args: Record<string, unknown>) {
  const sent: any[] = [];
  await answerAssistantUi({ type: "assistant_ui", requestId: ID, op, args }, { projectName: "__assistant__" }, (m) => sent.push(JSON.parse(m)));
  expect(sent).toHaveLength(1);
  return sent[0];
}

describe("list_commands", () => {
  it("lists the registry with each command's changesData, narrowed by every word of the query", async () => {
    useProjectStore.setState({ activeProject: { name: "demo", path: "/demo" } as never });
    useExtensionStore.setState({ contributions: { commands: [{ command: "git.pull", title: "Pull", category: "Git" }] } as never });
    const all = await ask("list_commands", {});
    expect(all.ok).toBe(true);
    expect(all.data.project).toBe("demo");
    expect(all.data.commands[0]).toEqual({ id: "chat", label: "New AI Chat", shortcut: "Ctrl+L", changesData: false });
    expect(all.data.commands.find((c: any) => c.id === "ext:git.pull")).toEqual({ id: "ext:git.pull", label: "Pull", hint: "Git", changesData: true });
    expect(all.data.total).toBe(all.data.commands.length);

    const narrowed = await ask("list_commands", { query: "new terminal" });
    expect(narrowed.data.commands.map((c: any) => c.id)).toEqual(["terminal"]);
    const one = await ask("list_commands", { id: "word-wrap" });
    expect(one.data.commands).toEqual([{ id: "word-wrap", label: "Toggle Word Wrap", shortcut: "Alt+Z", changesData: true }]);
  });
});

describe("run_command", () => {
  it("runs a command that changes nothing, in the project the device shows", async () => {
    useProjectStore.setState({ activeProject: { name: "demo", path: "/demo" } as never });
    const openTab = spyOn(useTabStore.getState(), "openTab").mockReturnValue("tab-1");
    try {
      const answer = await ask("run_command", { id: "terminal" });
      expect(answer).toMatchObject({ ok: true, data: { ran: true, id: "terminal", label: "New Terminal", project: "demo" } });
      expect(openTab).toHaveBeenCalledTimes(1);
      expect(openTab).toHaveBeenCalledWith({ type: "terminal", title: "Terminal", projectId: "demo", metadata: { projectName: "demo" }, closable: true });
    } finally {
      openTab.mockRestore();
    }
  });

  it("refuses an id the registry does not offer", async () => {
    for (const id of ["rm -rf", "ext:not.installed", "", 42]) {
      const answer = await ask("run_command", { id });
      expect(answer.ok).toBe(false);
    }
  });

  it("runs a command that changes data only with the approval for that same command", async () => {
    const toggle = spyOn(useSettingsStore.getState(), "toggleWordWrap").mockImplementation(() => {});
    try {
      const unapproved = await ask("run_command", { id: "word-wrap" });
      expect(unapproved.ok).toBe(false);
      expect(unapproved.error).toContain("only once the user approved");
      const otherLabel = await ask("run_command", { id: "word-wrap", approved: true, approvedLabel: "Something else" });
      expect(otherLabel.ok).toBe(false);
      expect(otherLabel.error).toContain("no longer the command the user approved");
      expect(toggle).not.toHaveBeenCalled();

      const approved = await ask("run_command", { id: "word-wrap", approved: true, approvedLabel: "Toggle Word Wrap" });
      expect(approved).toMatchObject({ ok: true, data: { ran: true, id: "word-wrap" } });
      expect(toggle).toHaveBeenCalledTimes(1);
    } finally {
      toggle.mockRestore();
    }
  });

  it("treats an extension's command as changing data", async () => {
    useExtensionStore.setState({ contributions: { commands: [{ command: "git.pull", title: "Pull" }] } as never });
    const fired: unknown[] = [];
    const listen = (e: Event) => fired.push((e as CustomEvent).detail);
    window.addEventListener("ext:command:execute", listen);
    try {
      expect((await ask("run_command", { id: "ext:git.pull" })).ok).toBe(false);
      expect(fired).toEqual([]);
      expect((await ask("run_command", { id: "ext:git.pull", approved: true, approvedLabel: "Pull" })).ok).toBe(true);
      expect(fired).toEqual([{ command: "git.pull", args: [] }]);
    } finally {
      window.removeEventListener("ext:command:execute", listen);
    }
  });
});
