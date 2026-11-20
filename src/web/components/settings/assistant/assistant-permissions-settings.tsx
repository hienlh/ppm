/**
 * Settings → PPM Assistant → General → Permissions: what the Assistant may do without a card.
 *
 * First the mode. Full is like a chat in bypass mode for turns the user starts; Ask shows a card
 * before each change, with the two switches below as its finer settings. Each control saves the
 * moment it changes (through `patchAssistantSettings`, which names only that key), apart from the
 * General pane's draft and its Save. Choosing Full, and turning "act on its own" on, asks first;
 * going back only takes something away, so it needs no confirmation. The window's quick switch
 * (`assistant-mode-button.tsx`) changes the same mode and this pane follows it.
 */
import { useEffect, useState } from "react";
import { useSettingsChanged } from "@/hooks/use-settings-changed";
import { toast } from "sonner";
import { Hand, Loader2, ShieldCheck, Zap } from "@/lib/icons";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { getAssistantSettings, patchAssistantSettings, type AssistantSettingsResponse } from "@/lib/assistant-settings-api";
import { TEXT_CONTROL_HEIGHT } from "@/lib/control-size";
import { FULL_MODE_CONFIRM, useAssistantPermissionMode } from "@/hooks/use-assistant-permission-mode";

export { FULL_MODE_CONFIRM };
import type { AssistantPermissionMode } from "../../../../shared/assistant-settings";
import { SettingLine, SettingsCard } from "./assistant-settings-card";
import { ConfirmDialog } from "./assistant-settings-dialog";
import { AssistantDbWriteConnections } from "./assistant-db-write-connections";

export const MODE_LABEL = "Mode";
export const MODE_HINTS: Record<AssistantPermissionMode, string> = {
  full: "Like a chat in bypass mode: in turns you start, here or on Telegram, the Assistant does what you ask without cards. Pushing, publishing, sending to other people, database writes, the vault and your private folders still ask, and turns PPM starts on its own never act.",
  ask: "The Assistant shows a card before each change. The two switches below decide what runs without one.",
};
export const MODE_UNSET_HINT = "Not chosen yet: the Assistant asks until you pick one.";
export const READONLY_COMMANDS_LABEL = "Run read-only commands without asking";
export const READONLY_COMMANDS_HINT = "Commands PPM can prove only read — git status, listing files in your projects, process and memory info — run without a card. Anything else still asks. Never reaches your keys, credential folders or PPM's own data.";
export const ACT_ON_OWN_LABEL = "Let the Assistant act on its own";
export const ACT_ON_OWN_HINT = "Edits files and runs commands without asking, in conversations you start. PPM's own approvals, pushing or posting, and your private folders still ask.";
export const ACT_ON_OWN_IN_FULL_HINT = "Included in Full mode.";
export const ACT_ON_OWN_CONFIRM = "The Assistant will edit files in your projects and run any command without asking, in conversations you start (not in watch or scheduled turns). It reads other chats, logs and web results, and text in them can try to steer it. PPM's own approvals (database changes, git, messages to chats), pushing or posting, and your private folders still ask. An Assistant chat already open takes this on at once for everything but file edits, and restarts for those the moment it is idle.";

/**
 * Buttons follow the chip-row standard (docs/design-guidelines.md rule 3): 28px with text on a
 * desktop, 26px on a phone. The switches keep their own size.
 */
const CONFIRM_BUTTON = `${TEXT_CONTROL_HEIGHT} px-2.5 text-xs`;
const MODE_BUTTON = `${TEXT_CONTROL_HEIGHT} inline-flex items-center gap-1.5 rounded-full border px-2.5 text-[11.5px] font-medium max-md:px-[5px]`;

interface Switches { readonly: boolean; actOnOwn: boolean; dbWrite: number[] }

function switchesFrom(res: AssistantSettingsResponse): Switches {
  const s = res.settings;
  // A server older than these switches sends neither: read-only commands default on, acting on its own off.
  return { readonly: s.auto_readonly_commands !== false, actOnOwn: s.act_on_own === true, dbWrite: s.db_write_connections ?? [] };
}

export function AssistantPermissionsSettings() {
  const [saved, setSaved] = useState<Switches | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState<"act_on_own" | "full" | null>(null);
  const { mode, setMode, saving: savingMode } = useAssistantPermissionMode();

  // Read again when the Assistant's settings change elsewhere (its settings tools, another device).
  const [reloads, setReloads] = useState(0);
  useSettingsChanged("assistant", () => setReloads((n) => n + 1));

  useEffect(() => {
    let live = true;
    getAssistantSettings()
      .then((res) => { if (live) setSaved(switchesFrom(res)); })
      .catch((e: Error) => { if (live) setError(e.message || "Could not load the Assistant's settings"); });
    return () => { live = false; };
  }, [reloads]);

  if (error) return <p className="text-xs text-error" role="alert">{error}</p>;
  if (!saved || mode === null) return <div className="flex justify-center py-6 text-muted-foreground"><Loader2 className="size-4 animate-spin" /></div>;

  const full = mode === "full";
  const save = async (patch: { auto_readonly_commands?: boolean; act_on_own?: boolean }) => {
    setSaving(true);
    try {
      setSaved(switchesFrom(await patchAssistantSettings(patch)));
    } catch (e) {
      toast.error("Could not save", { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setSaving(false);
    }
  };
  const choose = (next: AssistantPermissionMode) => {
    if (next === mode) return;
    if (next === "full") { setConfirming("full"); return; }
    setMode(next).catch((e: unknown) => toast.error("Could not save", { description: e instanceof Error ? e.message : String(e) }));
  };
  const modeButton = (value: AssistantPermissionMode, label: string, Icon: typeof Zap) => (
    <button
      type="button" role="radio" aria-checked={mode === value} disabled={savingMode}
      data-mode-option={value}
      onClick={() => choose(value)}
      className={cn(
        MODE_BUTTON,
        mode === value ? "border-primary bg-primary/10 text-text" : "border-border text-text-secondary hover:bg-surface-elevated",
      )}
    >
      <Icon className="size-3.5" />{label}
    </button>
  );

  return (
    <div data-testid="assistant-permissions">
      <SettingsCard icon={ShieldCheck} title="Permissions">
        <SettingLine label={MODE_LABEL} note={mode === "unset" ? `${MODE_UNSET_HINT} ${MODE_HINTS.ask}` : MODE_HINTS[mode]}>
          <div role="radiogroup" aria-label="Assistant permission mode" className="flex gap-1.5" data-testid="assistant-mode">
            {modeButton("full", "Full", Zap)}
            {modeButton("ask", "Ask", Hand)}
          </div>
        </SettingLine>
        {full && <AssistantDbWriteConnections initial={saved.dbWrite}
          onSaved={(ids) => setSaved((s) => (s ? { ...s, dbWrite: ids } : s))} />}
        <SettingLine label={READONLY_COMMANDS_LABEL} note={READONLY_COMMANDS_HINT}>
          <Switch aria-label={READONLY_COMMANDS_LABEL} checked={saved.readonly} disabled={saving}
            onCheckedChange={(on) => void save({ auto_readonly_commands: on })} />
        </SettingLine>
        <SettingLine label={ACT_ON_OWN_LABEL} note={full ? ACT_ON_OWN_IN_FULL_HINT : ACT_ON_OWN_HINT}>
          <Switch aria-label={ACT_ON_OWN_LABEL} checked={full || saved.actOnOwn} disabled={saving || full}
            onCheckedChange={(on) => { if (on) setConfirming("act_on_own"); else void save({ act_on_own: false }); }} />
        </SettingLine>
      </SettingsCard>
      <ConfirmDialog open={confirming === "act_on_own"} title={`${ACT_ON_OWN_LABEL}?`} confirmLabel="Turn on" buttonClassName={CONFIRM_BUTTON}
        onClose={() => setConfirming(null)}
        onConfirm={() => { setConfirming(null); void save({ act_on_own: true }); }}>
        {ACT_ON_OWN_CONFIRM}
      </ConfirmDialog>
      <ConfirmDialog open={confirming === "full"} title="Switch the Assistant to Full mode?" confirmLabel="Use Full" buttonClassName={CONFIRM_BUTTON}
        onClose={() => setConfirming(null)}
        onConfirm={() => {
          setConfirming(null);
          setMode("full").catch((e: unknown) => toast.error("Could not save", { description: e instanceof Error ? e.message : String(e) }));
        }}>
        {FULL_MODE_CONFIRM}
      </ConfirmDialog>
    </div>
  );
}
