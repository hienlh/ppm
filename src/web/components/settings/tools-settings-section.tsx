/**
 * Settings → Tools: PPM's own tools for the AI chat, on or off one by one, for Claude and Codex
 * alike (`ai.ppm_tools`; the defaults are in `src/shared/ppm-tools.ts`).
 */
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { getAISettings, updateAISettings, type AISettings } from "@/lib/api-settings";
import { DB_TOOLS } from "../../../shared/db-ai-tools";
import { ppmToolOn, TAB_TOOLS, type PpmTool } from "../../../shared/ppm-tools";
import { SectionHeader, SwitchRow } from "./settings-rows";

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
};

const GROUPS: Array<{ title: string; intro: string; tools: readonly PpmTool[] }> = [
  { title: "Tabs", intro: "On the device you are chatting from.", tools: TAB_TOOLS },
  {
    title: "Database",
    intro: "On the connections with “Available to the AI chat” on. The AI never sees their passwords.",
    tools: DB_TOOLS,
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

  useEffect(() => {
    void load();
  }, [load]);

  // Shown at once; a refused save reloads what the server actually has.
  const toggle = useCallback(async (tool: PpmTool, on: boolean) => {
    setSettings((current) => (current ? { ...current, ppm_tools: { ...current.ppm_tools, [tool]: on } } : current));
    try {
      setSettings(await updateAISettings({ ppm_tools: { [tool]: on } }));
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
        PPM's own tools for the AI chat, with Claude and Codex alike. New chats get the tools that are
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
                  </>
                }
                note={TOOL_COPY[tool].note}
                checked={ppmToolOn(settings, tool)}
                onChange={(on) => void toggle(tool, on)}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
