import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Loader2, Pencil, Plus, Trash2 } from "@/lib/icons";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { getAssistantSettings, saveAssistantSettings, type AssistantSettingsResponse } from "@/lib/assistant-settings-api";
import { foldMcpName, type AssistantMcpServer, type AssistantSettingsView } from "../../../shared/assistant-settings";
import { AssistantProviderDefaultsRow } from "./assistant-provider-defaults";
import { AssistantMcpServerDialog } from "./assistant-mcp-server-dialog";
import { IconButton, SectionHeader } from "./settings-rows";
import { cn } from "@/lib/utils";
import { AssistantTelegramSettings } from "./assistant-telegram-settings";
import { AssistantLegacyMemories, appendToInstructions } from "./assistant-legacy-memories";
import { ASSISTANT_SETTINGS_TABS, useAssistantSettingsTab, type AssistantSettingsTabId } from "./assistant-settings-tab-store";

const CHAT_DEFAULT = "__chat__";

/** Env or header names saved for a server, read from what the server last sent. */
function savedKeysOf(server: AssistantMcpServer | undefined): Set<string> {
  if (!server) return new Set();
  return new Set(Object.keys(server.transport === "stdio" ? server.env : server.headers));
}

/**
 * Settings → PPM Assistant, in two sub-tabs: General (what sessions run with) and Telegram (the
 * bot that reaches them from a phone). Each panel stays mounted once shown, so switching away
 * and back keeps an unsaved draft instead of reloading over it.
 */
export function AssistantSettingsSection() {
  const tab = useAssistantSettingsTab((s) => s.tab);
  const setTab = useAssistantSettingsTab((s) => s.setTab);
  const [shown, setShown] = useState<ReadonlySet<AssistantSettingsTabId>>(() => new Set([tab]));
  useEffect(() => {
    setShown((prev) => (prev.has(tab) ? prev : new Set([...prev, tab])));
  }, [tab]);

  return (
    <div className="space-y-5" data-testid="assistant-settings" data-tab={tab}>
      <div role="tablist" aria-label="PPM Assistant settings" className="flex gap-1 overflow-x-auto border-b border-border/50">
        {ASSISTANT_SETTINGS_TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            data-testid={`assistant-settings-tab-${t.id}`}
            onClick={() => setTab(t.id)}
            className={cn(
              "flex min-h-11 shrink-0 cursor-pointer items-center whitespace-nowrap rounded-t px-3 text-sm transition-colors md:min-h-9 md:text-xs",
              tab === t.id
                ? "border-b-2 border-primary font-medium text-primary"
                : "text-text-subtle hover:text-text-secondary",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      {(shown.has("general") || tab === "general") && (
        <div role="tabpanel" hidden={tab !== "general"}><AssistantGeneralSettings /></div>
      )}
      {(shown.has("telegram") || tab === "telegram") && (
        <div role="tabpanel" hidden={tab !== "telegram"}><AssistantTelegramSettings /></div>
      )}
    </div>
  );
}

/**
 * The Assistant's own provider, model, effort, instructions and MCP servers. Assistant sessions
 * use none of the settings, MCP servers, hooks, plugins or memory of ordinary chats, so
 * everything they run with is set here. One Save for the whole panel.
 */
function AssistantGeneralSettings() {
  const [loaded, setLoaded] = useState<AssistantSettingsResponse | null>(null);
  const [draft, setDraft] = useState<AssistantSettingsView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  /** The server open in the dialog: an index into the draft, or "new". */
  const [editing, setEditing] = useState<number | "new" | null>(null);

  useEffect(() => {
    let active = true;
    getAssistantSettings()
      .then((res) => { if (active) { setLoaded(res); setDraft(res.settings); } })
      .catch((e: Error) => { if (active) setLoadError(e.message || "Could not load the Assistant's settings"); });
    return () => { active = false; };
  }, []);

  const dirty = useMemo(() => !!loaded && !!draft && JSON.stringify(loaded.settings) !== JSON.stringify(draft), [loaded, draft]);

  if (loadError) return <p className="text-xs text-destructive" role="alert">{loadError}</p>;
  if (!loaded || !draft) {
    return <div className="flex items-center justify-center py-8 text-muted-foreground"><Loader2 className="size-4 animate-spin" /></div>;
  }

  const patch = (next: Partial<AssistantSettingsView>) => setDraft({ ...draft, ...next });
  const servers = draft.mcp_servers;
  const editingServer = typeof editing === "number" ? servers[editing] ?? null : null;
  const takenNames = new Set(servers.filter((_, i) => i !== editing).map((s) => foldMcpName(s.name)));
  const tooLong = draft.instructions.length > loaded.limits.instructionsMaxChars;

  const save = async () => {
    setSaving(true);
    try {
      const res = await saveAssistantSettings(draft);
      setLoaded(res);
      setDraft(res.settings);
      toast.success("Assistant settings saved");
    } catch (e) {
      toast.error("Could not save", { description: (e as Error).message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-5">
      <SectionHeader title="PPM Assistant">
        Assistant sessions use only these settings — none of your chats' settings, MCP servers, hooks,
        plugins, skills or memory. Changes apply from the next message on Claude, and from the next time
        a Codex Assistant session starts. The chat box can still change the model and effort of one session.
      </SectionHeader>

      <div className="space-y-1">
        <Label htmlFor="asst-default-provider" className="text-xs text-text-subtle">New sessions start on</Label>
        <Select value={draft.default_provider ?? CHAT_DEFAULT} disabled={saving}
          onValueChange={(v) => patch({ default_provider: v === CHAT_DEFAULT ? null : v })}>
          <SelectTrigger id="asst-default-provider" className="h-11 w-full md:h-8"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={CHAT_DEFAULT}>Same as chats</SelectItem>
            {loaded.providers.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      {loaded.providers.map((p) => (
        <AssistantProviderDefaultsRow key={p.id} provider={p} value={draft.providers[p.id] ?? {}} disabled={saving}
          onChange={(next) => {
            const { [p.id]: _old, ...others } = draft.providers;
            patch({ providers: next.model || next.effort ? { ...others, [p.id]: next } : others });
          }} />
      ))}

      <div className="space-y-1">
        <Label htmlFor="asst-instructions" className="text-xs text-text-subtle">Your instructions</Label>
        <textarea id="asst-instructions" rows={4} value={draft.instructions} disabled={saving}
          onChange={(e) => patch({ instructions: e.target.value })}
          placeholder="Added after PPM's own rules, which still come first. For example: answer in Vietnamese."
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm leading-relaxed placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" />
        <p className={tooLong ? "text-xs text-destructive" : "text-xs text-text-subtle"}>
          {draft.instructions.length.toLocaleString()} / {loaded.limits.instructionsMaxChars.toLocaleString()} characters
        </p>
        <AssistantLegacyMemories instructions={draft.instructions} disabled={saving}
          onCopy={(content) => patch({ instructions: appendToInstructions(draft.instructions, content) })} />
      </div>

      <div className="space-y-2">
        <SectionHeader title="MCP servers">
          Tool servers for Assistant sessions only. Every tool they offer asks you before it runs.
          Variable and header values stay on this machine and are never shown again.
        </SectionHeader>
        {servers.length === 0 && <p className="text-xs text-text-subtle">No MCP servers yet.</p>}
        <ul className="divide-y divide-border rounded-md border border-border">
          {servers.map((s, i) => (
            <li key={s.id || `new-${i}`} className="flex min-h-11 items-center gap-2 pl-3">
              <button type="button" className="min-w-0 flex-1 py-2 text-left" onClick={() => setEditing(i)}>
                <span className="block truncate text-sm">{s.name}</span>
                <span className="block truncate text-xs text-text-subtle">{s.transport === "stdio" ? [s.command, ...s.args].join(" ") : s.url}</span>
              </button>
              <Switch checked={s.enabled} disabled={saving} aria-label={`Use ${s.name}`}
                onCheckedChange={(on) => patch({ mcp_servers: servers.map((x, idx) => (idx === i ? { ...x, enabled: on } : x)) })} />
              <IconButton label={`Edit ${s.name}`} onClick={() => setEditing(i)} disabled={saving}><Pencil className="size-4" /></IconButton>
              <IconButton label={`Remove ${s.name}`} danger disabled={saving}
                onClick={() => patch({ mcp_servers: servers.filter((_, idx) => idx !== i) })}><Trash2 className="size-4" /></IconButton>
            </li>
          ))}
        </ul>
        <Button variant="outline" size="sm" className="h-11 gap-1 md:h-8" disabled={saving || servers.length >= loaded.limits.maxServers}
          onClick={() => setEditing("new")}>
          <Plus className="size-4" /> Add MCP server
        </Button>
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-border pt-3">
        {dirty && <span className="mr-auto text-xs text-text-subtle">Unsaved changes</span>}
        <Button variant="outline" size="sm" className="min-h-11 px-4 md:min-h-8" disabled={!dirty || saving} onClick={() => setDraft(loaded.settings)}>Discard</Button>
        <Button size="sm" className="min-h-11 px-4 md:min-h-8" disabled={!dirty || saving || tooLong} onClick={save}>
          {saving ? <Loader2 className="size-3.5 animate-spin" /> : "Save"}
        </Button>
      </div>

      <AssistantMcpServerDialog
        open={editing !== null}
        server={editingServer}
        savedKeys={savedKeysOf(editingServer ? loaded.settings.mcp_servers.find((s) => s.id === editingServer.id) : undefined)}
        takenNames={takenNames}
        onClose={() => setEditing(null)}
        onDone={(server) => {
          patch({ mcp_servers: editing === "new" ? [...servers, server] : servers.map((s, i) => (i === editing ? server : s)) });
          setEditing(null);
        }}
      />
    </div>
  );
}
