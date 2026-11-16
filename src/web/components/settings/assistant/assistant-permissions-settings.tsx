/**
 * Settings → PPM Assistant → General → Permissions: what the Assistant may run without a card.
 * Each switch saves the moment it flips (through `patchAssistantSettings`, which names only that
 * key), apart from the General pane's draft and its Save. Turning "act on its own" on asks first,
 * because it lets the Assistant edit files and run any command unasked; turning it off only
 * takes something away, so it needs no confirmation.
 */
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2, ShieldCheck } from "@/lib/icons";
import { Switch } from "@/components/ui/switch";
import { getAssistantSettings, patchAssistantSettings, type AssistantSettingsResponse } from "@/lib/assistant-settings-api";
import { TEXT_CONTROL_HEIGHT } from "@/lib/control-size";
import { SettingLine, SettingsCard } from "./assistant-settings-card";
import { ConfirmDialog } from "./assistant-settings-dialog";

export const READONLY_COMMANDS_LABEL = "Run read-only commands without asking";
export const READONLY_COMMANDS_HINT = "Commands PPM can prove only read — git status, listing files in your projects, process and memory info — run without a card. Anything else still asks. Never reaches your keys, credential folders or PPM's own data.";
export const ACT_ON_OWN_LABEL = "Let the Assistant act on its own";
export const ACT_ON_OWN_HINT = "Edits files and runs commands without asking, in conversations you start. PPM's own approvals and your private folders still ask.";
export const ACT_ON_OWN_CONFIRM = "The Assistant will edit files in your projects and run any command without asking, in conversations you start (not in watch or scheduled turns). It reads other chats, logs and web results, and text in them can try to steer it. PPM's own approvals (database changes, git, messages to chats) and your private folders still ask. Edits become available from the Assistant's next session start.";

/**
 * The confirm's buttons follow the chip-row standard (docs/design-guidelines.md rule 3): 28px with
 * text on a desktop, 26px on a phone. The switches keep their own size and get no invisible
 * press area, which the standard asks not to add.
 */
const CONFIRM_BUTTON = `${TEXT_CONTROL_HEIGHT} px-2.5 text-xs`;

interface Switches { readonly: boolean; actOnOwn: boolean }

function switchesFrom(res: AssistantSettingsResponse): Switches {
  const s = res.settings;
  // A server older than these switches sends neither: read-only commands default on, acting on its own off.
  return { readonly: s.auto_readonly_commands !== false, actOnOwn: s.act_on_own === true };
}

export function AssistantPermissionsSettings() {
  const [saved, setSaved] = useState<Switches | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    let live = true;
    getAssistantSettings()
      .then((res) => { if (live) setSaved(switchesFrom(res)); })
      .catch((e: Error) => { if (live) setError(e.message || "Could not load the Assistant's settings"); });
    return () => { live = false; };
  }, []);

  if (error) return <p className="text-xs text-error" role="alert">{error}</p>;
  if (!saved) return <div className="flex justify-center py-6 text-muted-foreground"><Loader2 className="size-4 animate-spin" /></div>;

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

  return (
    <div data-testid="assistant-permissions">
      <SettingsCard icon={ShieldCheck} title="Permissions">
        <SettingLine label={READONLY_COMMANDS_LABEL} note={READONLY_COMMANDS_HINT}>
          <Switch aria-label={READONLY_COMMANDS_LABEL} checked={saved.readonly} disabled={saving}
            onCheckedChange={(on) => void save({ auto_readonly_commands: on })} />
        </SettingLine>
        <SettingLine label={ACT_ON_OWN_LABEL} note={ACT_ON_OWN_HINT}>
          <Switch aria-label={ACT_ON_OWN_LABEL} checked={saved.actOnOwn} disabled={saving}
            onCheckedChange={(on) => { if (on) setConfirming(true); else void save({ act_on_own: false }); }} />
        </SettingLine>
      </SettingsCard>
      <ConfirmDialog open={confirming} title={`${ACT_ON_OWN_LABEL}?`} confirmLabel="Turn on" buttonClassName={CONFIRM_BUTTON}
        onClose={() => setConfirming(false)}
        onConfirm={() => { setConfirming(false); void save({ act_on_own: true }); }}>
        {ACT_ON_OWN_CONFIRM}
      </ConfirmDialog>
    </div>
  );
}
