/**
 * Settings → PPM Assistant → Manager chats: one row per project — its manager chat, mode, rules,
 * Telegram detail and digest switch — the default mode for new manager chats, and the template
 * new rules files start from. A chat's own mode is changed in its composer; only the default
 * for new ones is set here. The list follows `assistant:managers_changed`.
 */
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Loader2, Pencil, Users } from "@/lib/icons";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { refreshManagerChats, useManagerChats } from "@/hooks/use-manager-chats";
import { useProjectStore } from "@/stores/project-store";
import { getAssistantSettings, patchAssistantSettings } from "@/lib/assistant-settings-api";
import { patchManagerChat, unassignManagerChat } from "@/lib/assistant-settings-client";
import {
  BYPASS_DEFAULT_CONSEQUENCE, MANAGER_MODE_OPTIONS, RULES_GUARD_HINT, managerTableRows,
} from "@/lib/assistant-manager-table";
import { openManagerChat } from "@/components/assistant/open-manager-chat";
import type { ManagerChatSummary } from "../../../../shared/assistant-managers";
import type { ManagerMode } from "../../../../shared/assistant-settings";
import { SettingLine, SettingsCard } from "./assistant-settings-card";
import { ConfirmDialog } from "./assistant-settings-dialog";
import { MANAGER_GRID, ManagerChatRow, type ManagerRowActions } from "./manager-chat-row";
import { AssignManagerDialog } from "./assign-manager-dialog";
import { ManagerRulesDialog } from "./manager-rules-dialog";
import { ManagerTemplateDialog } from "./manager-template-dialog";

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const HEAD = "hidden px-3.5 py-2 text-[11px] font-semibold uppercase tracking-wider text-text-subtle";

interface Defaults { mode: ManagerMode; template: string; builtIn: string }

export function AssistantManagerChatsSection() {
  const managers = useManagerChats();
  const projects = useProjectStore((s) => s.projects);
  const rows = useMemo(() => managerTableRows(projects, managers ?? []), [projects, managers]);
  const [defaults, setDefaults] = useState<Defaults | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [assigning, setAssigning] = useState<string | null>(null);
  const [editingRules, setEditingRules] = useState<string | null>(null);
  const [unsetting, setUnsetting] = useState<ManagerChatSummary | null>(null);
  const [confirmBypass, setConfirmBypass] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState(false);

  useEffect(() => {
    // Each visit asks again: whether a chat's tools still wait for its next start is not announced.
    void refreshManagerChats();
    let live = true;
    getAssistantSettings()
      .then((r) => { if (live) setDefaults({ mode: r.settings.manager_default_mode, template: r.settings.manager_template, builtIn: r.managerTemplateBuiltIn ?? "" }); })
      .catch((e) => toast.error("Could not load the Assistant's settings", { description: errorText(e) }));
    return () => { live = false; };
  }, []);

  const saveMode = async (mode: ManagerMode) => {
    try {
      const r = await patchAssistantSettings({ manager_default_mode: mode });
      setDefaults((d) => (d ? { ...d, mode: r.settings.manager_default_mode } : d));
    } catch (e) {
      toast.error("Could not save the default mode", { description: errorText(e) });
    }
  };

  const actions: ManagerRowActions = {
    onOpen: (m) => void openManagerChat({ projectName: m.projectName, sessionId: m.sessionId, title: m.title }),
    onEditRules: (m) => setEditingRules(m.projectName),
    onAssign: setAssigning,
    onUnset: setUnsetting,
    onPatch: (m, patch) => {
      setBusy(m.projectName);
      patchManagerChat(m.projectName, patch)
        .catch((e) => toast.error("Could not save", { description: errorText(e) }))
        .finally(() => setBusy(null));
    },
  };

  const unset = async (m: ManagerChatSummary) => {
    try {
      await unassignManagerChat(m.projectName);
      toast.success(`${m.projectName} has no manager chat now`, { description: "The chat keeps its history." });
    } catch (e) {
      toast.error("Could not unset the manager chat", { description: errorText(e) });
    }
  };

  const modeControl = defaults && (
    <label className="flex items-center gap-2">
      <span>Default mode for new manager chats</span>
      <Select value={defaults.mode} onValueChange={(v) => (v === "bypassPermissions" ? setConfirmBypass(true) : void saveMode(v as ManagerMode))}>
        <SelectTrigger aria-label="Default mode for new manager chats" className="h-11 w-44 text-xs md:h-8"><SelectValue /></SelectTrigger>
        <SelectContent>{MANAGER_MODE_OPTIONS.map((o) => <SelectItem key={o.id} value={o.id}>{o.label}</SelectItem>)}</SelectContent>
      </Select>
    </label>
  );

  return (
    <div className="space-y-2" data-testid="assistant-managers-section">
      <SettingsCard icon={Users} title="Manager chats" aside={modeControl}>
        <div className={`${HEAD} ${MANAGER_GRID}`} aria-hidden>
          <span>Project</span><span>Manager chat</span><span>Mode</span><span>Rules</span><span>Telegram</span><span>Digest</span><span />
        </div>
        {managers === null && <p className="flex items-center gap-2 px-3.5 py-3 text-sm text-text-subtle"><Loader2 className="size-3.5 animate-spin" />Loading…</p>}
        {managers !== null && rows.length === 0 && <p className="px-3.5 py-3 text-sm text-text-subtle">No projects yet.</p>}
        {managers !== null && rows.map((row) => (
          <ManagerChatRow key={row.projectName} row={row} busy={busy === row.projectName} actions={actions} />
        ))}
        <SettingLine
          label="Template for new manager rules"
          note="Copied into .ppm/manager.md when a project gets a manager chat. The manager may tighten its rules; loosening them waits for you."
        >
          <Button variant="outline" size="sm" className="min-h-11 gap-1 md:min-h-8" disabled={!defaults} onClick={() => setEditingTemplate(true)}>
            <Pencil className="size-3.5" />Edit template
          </Button>
        </SettingLine>
      </SettingsCard>
      <p className="px-1 text-xs text-text-subtle">{RULES_GUARD_HINT}</p>

      {assigning && defaults && (
        <AssignManagerDialog projectName={assigning} current={managers?.find((m) => m.projectName === assigning) ?? null}
          defaultMode={defaults.mode} onClose={() => setAssigning(null)} />
      )}
      {editingRules && <ManagerRulesDialog projectName={editingRules} onClose={() => setEditingRules(null)} />}
      {editingTemplate && defaults && (
        <ManagerTemplateDialog template={defaults.template} builtIn={defaults.builtIn}
          onSaved={(template) => setDefaults((d) => (d ? { ...d, template } : d))} onClose={() => setEditingTemplate(false)} />
      )}
      <ConfirmDialog open={confirmBypass} title="Bypass permissions for new manager chats?" confirmLabel="Use bypass"
        destructive onClose={() => setConfirmBypass(false)} onConfirm={() => { setConfirmBypass(false); void saveMode("bypassPermissions"); }}>
        {BYPASS_DEFAULT_CONSEQUENCE}.
      </ConfirmDialog>
      <ConfirmDialog open={unsetting !== null} title={`Unset the ${unsetting?.projectName ?? ""} manager chat?`} confirmLabel="Unset"
        onClose={() => setUnsetting(null)} onConfirm={() => { if (unsetting) void unset(unsetting); setUnsetting(null); }}>
        PPM Assistant stops messaging “{unsetting?.title || "this chat"}” about the project. The chat and its rules file stay.
      </ConfirmDialog>
    </div>
  );
}
