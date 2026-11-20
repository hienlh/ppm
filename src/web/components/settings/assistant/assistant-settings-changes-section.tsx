/**
 * Settings → PPM Assistant → Changes: the switch that lets the Assistant change settings, and every
 * setting it changed (installs and removals too), newest first, each with Undo while the value is
 * still the one it set. Undo here is the user's own press, so it needs no card. Refreshes on
 * `assistant:settings_changes_changed` and after a `/ws/global` reconnect.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { History, Loader2, Undo2 } from "@/lib/icons";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { onGlobalReady } from "@/lib/global-ws-channel";
import { listSettingChanges, setSettingsToolsOn, undoSettingChange } from "@/lib/assistant-settings-changes-client";
import { SETTING_CHANGES_EVENT, type SettingChangesList, type SettingChangeView } from "../../../../shared/assistant-settings-changes";
import { SettingsCard, SettingLine } from "./assistant-settings-card";
import { changeHowBadges, filterChanges, undoNote, type ChangesFilter } from "./assistant-settings-changes-view";

const FILTERS: Array<{ id: ChangesFilter; label: string }> = [
  { id: "all", label: "All" }, { id: "settings", label: "Settings" }, { id: "installs", label: "Installs" }, { id: "undone", label: "Undone" },
];

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const time = (at: number) => new Date(at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

function useSettingChanges() {
  const [view, setView] = useState<SettingChangesList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const reload = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const next = await listSettingChanges();
      if (mine === seq.current) { setView(next); setError(null); }
    } catch (e) {
      if (mine === seq.current) setError(errorText(e));
    }
  }, []);
  useEffect(() => {
    void reload();
    const onChange = () => void reload();
    window.addEventListener(SETTING_CHANGES_EVENT, onChange);
    const offReady = onGlobalReady(onChange);
    return () => { window.removeEventListener(SETTING_CHANGES_EVENT, onChange); offReady(); };
  }, [reload]);
  return { view, error, reload };
}

function ChangeRow({ change, busy, onUndo }: { change: SettingChangeView; busy: boolean; onUndo: () => void }) {
  const note = undoNote(change);
  return (
    <li className="flex flex-col gap-1.5 px-3.5 py-2.5" data-setting-change={change.id}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="min-w-0 break-words text-sm font-medium">{change.label}</span>
        <span className="shrink-0 text-xs tabular-nums text-text-subtle">{time(change.at)}</span>
      </div>
      {change.kind === "setting" ? (
        <div className="break-words text-sm">
          <span className="text-text-secondary line-through decoration-text-subtle">{change.beforeText}</span>
          <span className="px-1.5 text-text-subtle">→</span>
          <span className="font-semibold">{change.afterText}</span>
        </div>
      ) : (
        <div className="text-sm">{change.afterText}</div>
      )}
      {change.note && <div className="text-xs italic text-text-secondary">{change.note}</div>}
      {note && <div className="text-xs text-text-subtle">{note}</div>}
      <div className="flex flex-wrap items-center gap-1.5">
        {changeHowBadges(change).map((b) => (
          <span key={b.label} className={cn("rounded border px-1.5 py-px text-[11px]", b.tone === "full" ? "border-warning/50 text-warning" : b.tone === "card" ? "border-primary/50 text-primary" : "border-border text-text-secondary")}>{b.label}</span>
        ))}
        <span className="flex-1" />
        {change.undo === null && (
          <Button variant="outline" size="sm" className="min-h-11 md:min-h-8" disabled={busy} onClick={onUndo} data-undo-change={change.id}>
            <Undo2 className="size-3.5" /> Undo
          </Button>
        )}
      </div>
    </li>
  );
}

export function AssistantSettingsChangesSection() {
  const { view, error, reload } = useSettingChanges();
  const [filter, setFilter] = useState<ChangesFilter>("all");
  const [busy, setBusy] = useState(false);
  const shown = useMemo(() => (view ? filterChanges(view.changes, filter) : []), [view, filter]);

  const act = async (work: () => Promise<unknown>, failure: string) => {
    setBusy(true);
    try {
      await work();
      await reload();
    } catch (e) {
      toast.error(failure, { description: errorText(e) });
      await reload();
    } finally {
      setBusy(false);
    }
  };

  if (error && !view) return <p className="text-xs text-error" role="alert">{error}</p>;
  if (!view) return <div className="flex justify-center py-8 text-muted-foreground"><Loader2 className="size-4 animate-spin" /></div>;

  return (
    <div className="@container space-y-4" data-testid="assistant-settings-changes">
      <SettingsCard icon={History} title="Settings the Assistant changes">
        <SettingLine
          label="Let the Assistant change settings"
          note="It can change PPM's settings and install Whisper, language servers and drivers. In Full mode ordinary settings change without a card; permissions, security, accounts and installs always ask. Tokens and passwords are never read or written."
        >
          <Switch checked={view.enabled} disabled={busy} aria-label="Let the Assistant change settings"
            onCheckedChange={(on) => void act(() => setSettingsToolsOn(on), "Could not save")} />
        </SettingLine>
      </SettingsCard>
      <SettingsCard icon={History} title="Changes" aside={<span>Kept 90 days</span>}>
        <div className="flex flex-wrap gap-1.5 px-3.5 py-2.5" role="tablist" aria-label="Show">
          {FILTERS.map((f) => (
            <button key={f.id} type="button" role="tab" aria-selected={filter === f.id} onClick={() => setFilter(f.id)}
              className={cn("min-h-9 rounded-full border px-3 text-xs", filter === f.id ? "border-primary bg-primary/15 text-text-primary" : "border-border text-text-secondary")}>
              {f.label}
            </button>
          ))}
        </div>
        {shown.length === 0 ? (
          <p className="px-3.5 py-6 text-center text-sm text-text-subtle">{view.changes.length ? "Nothing here." : "The Assistant has not changed any setting yet."}</p>
        ) : (
          <ul className="divide-y divide-border-soft">
            {shown.map((c) => <ChangeRow key={c.id} change={c} busy={busy} onUndo={() => void act(() => undoSettingChange(c.id), "Could not undo")} />)}
          </ul>
        )}
        <p className="px-3.5 py-2 text-xs text-text-subtle">Secrets are never listed here: a change that removed one says so, without its value.</p>
      </SettingsCard>
    </div>
  );
}
