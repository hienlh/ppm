/**
 * Settings → Tools: PPM's own tools for the AI chat, on or off one by one, for Claude, Codex and
 * Antigravity alike (`ai.ppm_tools`; the defaults are in `src/shared/ppm-tools.ts`).
 */
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { getAISettings, updateAISettings, type AISettings } from "@/lib/api-settings";
import { DB_TOOLS } from "../../../shared/db-ai-tools";
import { patchPpmToolSwitches, ppmToolOn, TERMINAL_TOOLS, type PpmTool } from "../../../shared/ppm-tools";
import { FEATURE_INTROS_CHANGED_EVENT } from "../../../shared/feature-intros";
import { useNewFeatureTools } from "./use-new-feature-tools";
import { SESSION_HISTORY_TOOLS } from "../../../shared/session-history-tools";
import { SESSION_COLLAB_TOOLS } from "../../../shared/session-collab";
import { SPEC_TOOLS } from "../../../shared/spec-tools";
import type { SessionCollabSettings } from "../../../shared/session-collab-settings";
import { SectionHeader, SwitchRow } from "./settings-rows";
import { SessionCollabSettingsControls } from "./session-collab-settings-controls";

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

const TOOL_COPY: Record<PpmTool, { label: string; note: string }> = {
  open_file: {
    label: "Open files",
    note: "Opens a file in a PPM tab, at a line when it points you at one.",
  },
  open_preview: {
    label: "Show pages",
    note: "Opens a page, chart or report it made in a PPM tab, and reads back its errors and a screenshot. While on, Claude's claude.ai Artifact tool is off.",
  },
  open_url: {
    label: "Show running apps",
    note: "Opens a web server running on this machine, such as a dev server, in a PPM tab. On another device it goes through a private Tailscale forward; it never makes a public link.",
  },
  read_terminal: {
    label: "Read terminals",
    note: "Reads what the terminals of the chat's project printed, so you need not paste an error into the chat.",
  },
  run_in_terminal: {
    label: "Type commands",
    note: "Opens a terminal with a command typed in, for one that needs your password or your eyes. Nothing runs until you press Enter.",
  },
  search_sessions: {
    label: "Search chats",
    note: "Searches the titles and the prompts and answers of this project's chats, never what tools printed, and says which turn each match is in.",
  },
  list_session_turns: {
    label: "List turns",
    note: "Lists the turns of one of this project's chats: number, time and the first line of each prompt.",
  },
  read_session_turns: {
    label: "Read turns",
    note: "Reads chosen turns of this project's chats: prompts, answers and one line per tool call. In another project, only the turns whose links you sent it.",
  },
  db_query: {
    label: "Read databases",
    note: "Runs read-only SQL. It cannot change anything.",
  },
  open_query: {
    label: "Open Query tabs",
    note: "Opens a Query tab holding a script it wrote. You press Run.",
  },
  db_execute: {
    label: "Change databases",
    note: "Runs a change only after you approve it with PPM's password, once, in one transaction.",
  },
  create_session: {
    label: "Create sessions",
    note: "Opens a new session of this project to hand work to. It shows in your session list, and you can open, chat into or stop it.",
  },
  send_to_session: {
    label: "Message sessions",
    note: "Sends a message to another session of this project, and can wait for its reply. Only an explicit message reaches another session.",
  },
  session_status: {
    label: "Check sessions",
    note: "Reads what the linked sessions are doing: running or idle, waiting on you, and the opening of their last answer.",
  },
  spec_status: {
    label: "Read the spec",
    note: "Reads where the chat's spec stands: each document, the tasks and their waves, the last test runs.",
  },
  spec_create: {
    label: "Start specs",
    note: "Starts a spec when you ask for one in an ordinary chat, which then works in Spec mode.",
  },
  spec_submit: {
    label: "Submit documents",
    note: "Says requirements, design or tasks are ready. PPM checks them and asks you to approve; the AI never approves.",
  },
  spec_open_design: {
    label: "Draw screens",
    note: "For a spec with a UI: creates its PPM Design and opens it, for the AI to draw the screens you approve before the design.",
  },
  task_start: {
    label: "Start tasks",
    note: "Starts a task of the approved plan, refused while its dependencies are open or a running task shares its files.",
  },
  task_done: {
    label: "Finish tasks",
    note: "Finishes a task (Standard checks). PPM ticks its box in tasks.md.",
  },
  task_red: {
    label: "Run failing tests",
    note: "Thorough checks: PPM runs the task's new tests and must see them fail before the code exists, then locks them.",
  },
  task_green: {
    label: "Run passing tests",
    note: "Thorough checks: PPM runs the locked tests, finishes the task when they pass, then compares the whole suite with the failures it had before.",
  },
  suite_check: {
    label: "Check the suite",
    note: "Thorough checks: runs the whole test suite again after fixing failures it reported.",
  },
};

const GROUPS: Array<{ title: string; intro: string; tools: readonly PpmTool[] }> = [
  { title: "Tabs", intro: "On the device you are chatting from.", tools: ["open_file", "open_preview", "open_url"] },
  { title: "Terminal", intro: "PPM's own terminals, on the machine PPM runs on.", tools: TERMINAL_TOOLS },
  {
    title: "Session history",
    intro: "Earlier chats of the chat's own project, read-only. Another project is reachable only through turn links you sent.",
    tools: SESSION_HISTORY_TOOLS,
  },
  {
    title: "Database",
    intro: "On the connections with “Available to the AI chat” on. The AI never sees their passwords.",
    tools: DB_TOOLS,
  },
  {
    title: "Session collaboration",
    intro: "Sessions of one project opening and messaging each other. Every session an AI creates is an ordinary one you can see, open and stop.",
    tools: SESSION_COLLAB_TOOLS,
  },
  {
    title: "Spec mode",
    intro: "Requirements, design and tasks you approve step by step. Thorough checks run the tests the design names, in the project folder.",
    tools: SPEC_TOOLS,
  },
];

export function ToolsSettingsSection() {
  const [settings, setSettings] = useState<AISettings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setSettings(await getAISettings());
      setLoadError(null);
    } catch (e) {
      setLoadError(errorText(e));
    }
  }, []);

  const newTools = useNewFeatureTools();

  useEffect(() => {
    void load();
    // A new-feature question answered on any device rewrites the switches it covers.
    const reload = () => void load();
    window.addEventListener(FEATURE_INTROS_CHANGED_EVENT, reload);
    return () => window.removeEventListener(FEATURE_INTROS_CHANGED_EVENT, reload);
  }, [load]);

  // Shown at once, as the server will store it; a refused save reloads what the server has.
  const toggle = useCallback(async (tool: PpmTool, on: boolean) => {
    setSettings((current) => (current ? { ...current, ppm_tools: patchPpmToolSwitches(current.ppm_tools, { [tool]: on }) } : current));
    try {
      setSettings(await updateAISettings({ ppm_tools: { [tool]: on } }));
    } catch (e) {
      toast.error("Could not save", { description: errorText(e) });
      await load();
    }
  }, [load]);

  const changeCollab = useCallback(async (patch: Partial<SessionCollabSettings>) => {
    setSettings((current) => (current ? { ...current, session_collab: { ...current.session_collab, ...patch } } : current));
    try {
      setSettings(await updateAISettings({ session_collab: patch }));
    } catch (e) {
      toast.error("Could not save", { description: errorText(e) });
      await load();
    }
  }, [load]);

  if (!settings) {
    return <p className="text-xs text-muted-foreground">{loadError ?? "Loading…"}</p>;
  }

  return (
    <div className="space-y-6">
      <p className="text-xs leading-relaxed text-muted-foreground">
        PPM's own tools for the AI chat, with Claude, Codex and Antigravity alike. New chats get the tools that are
        on; turning one off also stops it in chats already open.
      </p>
      {GROUPS.map((group) => (
        <section key={group.title} className="space-y-3">
          <SectionHeader title={group.title}>{group.intro}</SectionHeader>
          <div className="divide-y divide-border rounded-lg border border-border">
            {group.tools.map((tool) => (
              <SwitchRow
                key={tool}
                label={
                  <>
                    {TOOL_COPY[tool].label}
                    <code className="ml-2 font-mono text-[11px] text-muted-foreground">{tool}</code>
                    {newTools.has(tool) && (
                      <span data-new-tool={tool} className="ml-2 rounded bg-primary px-1.5 py-0.5 text-[10px] font-semibold uppercase text-primary-foreground">
                        New
                      </span>
                    )}
                  </>
                }
                note={TOOL_COPY[tool].note}
                checked={ppmToolOn(settings, tool)}
                onChange={(on) => void toggle(tool, on)}
              />
            ))}
          </div>
          {group.tools === SESSION_COLLAB_TOOLS && (
            <SessionCollabSettingsControls stored={settings.session_collab} onChange={(patch) => void changeCollab(patch)} />
          )}
        </section>
      ))}
    </div>
  );
}
