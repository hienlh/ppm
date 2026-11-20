/**
 * Settings → PPM Assistant → Digest & quiet hours: when PPM wakes or holds the Assistant on its
 * own, plus the restart-news switch. There is no time zone field: saving a time also sends this
 * browser's IANA zone, and the zone the times are read in is shown as plain text under them.
 */
import { useEffect, useState } from "react";
import { useSettingsChanged } from "@/hooks/use-settings-changed";
import { toast } from "sonner";
import { Coffee, Loader2, RotateCcw } from "@/lib/icons";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { browserTimeZone, getAssistantSettings, patchAssistantSettings, type AssistantSettingsResponse } from "@/lib/assistant-settings-api";
import { isClockTime, type QuietHours } from "../../../../shared/assistant-quiet-hours";
import type { DigestSettings } from "../../../../shared/assistant-digest";
import { SettingLine, SettingsCard } from "./assistant-settings-card";

export const DIGEST_HINT = "Asks each manager chat (queued while it is busy), then sends one digest.";
export const QUIET_HINT = "Messages are held until quiet hours end. Urgent items go out at once.";
export const RESTART_NEWS_LABEL = "Tell the Assistant after PPM restarts";
export const RESTART_NEWS_HINT = "After every restart, PPM wakes the Assistant with why it restarted and which chats were cut off, so it can ask their managers to continue.";

interface Saved { digest: DigestSettings; quiet: QuietHours; timezone: string | undefined; restartNews: boolean }

function savedFrom(res: AssistantSettingsResponse): Saved {
  const s = res.settings;
  // A server older than the switch sends none; the news is on unless switched off.
  return { digest: s.digest, quiet: s.quiet_hours, timezone: s.timezone, restartNews: s.restart_news !== false };
}

/** The read-only line naming the zone the times are in. */
export function zoneLine(saved: string | undefined, device: string | undefined): string {
  if (!saved) return "Times are in the server's time zone until you save one of them here.";
  const base = `Times are in ${saved} (this device's zone when you saved)`;
  return device && device !== saved ? `${base}. This device is on ${device}; saving again switches to it.` : `${base}.`;
}

function TimeField({ label, value, disabled, onCommit }: { label: string; value: string; disabled: boolean; onCommit: (v: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <Input
      type="time"
      step={60}
      aria-label={label}
      value={text}
      disabled={disabled}
      onChange={(e) => setText(e.target.value)}
      // Saved once the field is left, not per keystroke: typing "08:30" passes through "08:03".
      onBlur={() => { if (isClockTime(text) && text !== value) onCommit(text); else if (!isClockTime(text)) setText(value); }}
      onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
      // Wide enough for a 12-hour clock's "08:00 AM" as well as "08:00".
      className="h-11 w-36 tabular-nums md:h-9"
    />
  );
}

export function AssistantDigestQuietSection() {
  const [saved, setSaved] = useState<Saved | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Read again when the Assistant's settings change elsewhere (its settings tools, another device).
  const [reloads, setReloads] = useState(0);
  useSettingsChanged("assistant", () => setReloads((n) => n + 1));

  useEffect(() => {
    let live = true;
    getAssistantSettings()
      .then((res) => { if (live) setSaved(savedFrom(res)); })
      .catch((e: Error) => { if (live) setError(e.message || "Could not load the Assistant's settings"); });
    return () => { live = false; };
  }, [reloads]);

  if (error) return <p className="text-xs text-error" role="alert">{error}</p>;
  if (!saved) return <div className="flex justify-center py-8 text-muted-foreground"><Loader2 className="size-4 animate-spin" /></div>;

  // A time is read in the zone it was saved in, so saving one sends this browser's zone; the
  // restart-news switch holds no time and leaves the saved zone alone.
  const save = async (patch: { digest?: DigestSettings; quiet_hours?: QuietHours; restart_news?: boolean }) => {
    setSaving(true);
    try {
      const res = await patchAssistantSettings(patch.restart_news === undefined ? { ...patch, timezone: browserTimeZone() } : patch);
      setSaved(savedFrom(res));
    } catch (e) {
      toast.error("Could not save", { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setSaving(false);
    }
  };
  const { digest, quiet } = saved;

  return (
    <div className="space-y-2" data-testid="assistant-digest-section">
      <SettingsCard icon={Coffee} title="Digest & quiet hours">
        <SettingLine label="Morning digest" note={DIGEST_HINT}>
          <TimeField label="Digest time" value={digest.time} disabled={saving} onCommit={(time) => void save({ digest: { ...digest, time } })} />
          <Switch aria-label="Morning digest" checked={digest.enabled} disabled={saving}
            onCheckedChange={(enabled) => void save({ digest: { ...digest, enabled } })} />
        </SettingLine>
        <SettingLine label="Quiet hours" note={QUIET_HINT}>
          <TimeField label="Quiet hours start" value={quiet.start} disabled={saving} onCommit={(start) => void save({ quiet_hours: { ...quiet, start } })} />
          <span className="text-text-subtle" aria-hidden>–</span>
          <TimeField label="Quiet hours end" value={quiet.end} disabled={saving} onCommit={(end) => void save({ quiet_hours: { ...quiet, end } })} />
          <Switch aria-label="Quiet hours" checked={quiet.enabled} disabled={saving}
            onCheckedChange={(enabled) => void save({ quiet_hours: { ...quiet, enabled } })} />
        </SettingLine>
      </SettingsCard>
      <p className="px-1 text-xs text-text-subtle" data-testid="assistant-time-zone">{zoneLine(saved.timezone, browserTimeZone())}</p>
      <div className="pt-3" data-testid="assistant-restart-news">
        <SettingsCard icon={RotateCcw} title="Restarts">
          <SettingLine label={RESTART_NEWS_LABEL} note={RESTART_NEWS_HINT}>
            <Switch aria-label={RESTART_NEWS_LABEL} checked={saved.restartNews} disabled={saving}
              onCheckedChange={(restart_news) => void save({ restart_news })} />
          </SettingLine>
        </SettingsCard>
      </div>
    </div>
  );
}
