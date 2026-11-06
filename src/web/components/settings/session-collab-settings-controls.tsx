/**
 * Settings → Tools → Session collaboration, below the three tool switches: whether an AI asks
 * before creating a session, and the four limits (`ai.session_collab`). Each number is clamped to
 * the range the server enforces before it is sent, so what the field shows is what is saved.
 */
import { useEffect, useId, useState } from "react";
import { Input } from "@/components/ui/input";
import {
  clampSessionCollabNumber, resolveSessionCollabSettings, SESSION_COLLAB_LIMITS,
  type SessionCollabNumericSetting, type SessionCollabSettings,
} from "../../../shared/session-collab-settings";
import { SwitchRow } from "./settings-rows";

const NUMBERS: Array<{ key: SessionCollabNumericSetting; label: string; note: string; unit?: string }> = [
  { key: "maxDepth", label: "How deep", note: "Sessions created by created sessions, counted from one you started." },
  { key: "maxAutoMessagesPerPair", label: "Messages per pair", note: "Sent between two sessions before you are asked. Writing in either starts the count again." },
  { key: "maxRunningSpawned", label: "Running at once", note: "AI-created sessions of one project working at the same time." },
  { key: "waitTimeoutMinutes", label: "Longest wait", note: "How long a session waits for a reply before going on.", unit: "min" },
];

export function SessionCollabSettingsControls({ stored, onChange }: {
  stored: Partial<SessionCollabSettings> | undefined;
  onChange: (patch: Partial<SessionCollabSettings>) => void;
}) {
  const settings = resolveSessionCollabSettings(stored);
  return (
    <div className="divide-y divide-border rounded-lg border border-border" data-session-collab-settings="">
      <SwitchRow
        label="Ask before creating sessions"
        note="An AI asks you before it opens a new session. Messaging a session that already exists never asks."
        checked={settings.askBeforeCreate}
        onChange={(on) => onChange({ askBeforeCreate: on })}
      />
      {NUMBERS.map((n) => (
        <NumberRow key={n.key} setting={n} value={settings[n.key]} onCommit={(v) => onChange({ [n.key]: v })} />
      ))}
    </div>
  );
}

function NumberRow({ setting, value, onCommit }: {
  setting: (typeof NUMBERS)[number];
  value: number;
  onCommit: (value: number) => void;
}) {
  const id = useId();
  const { min, max } = SESSION_COLLAB_LIMITS[setting.key];
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);

  const commit = () => {
    const parsed = Number(draft);
    const next = Number.isFinite(parsed) && draft.trim() !== "" ? clampSessionCollabNumber(setting.key, parsed) : value;
    setDraft(String(next));
    if (next !== value) onCommit(next);
  };

  return (
    <div className="flex flex-col gap-2 px-4 py-3 md:flex-row md:items-center md:justify-between">
      <label htmlFor={id} className="min-w-0 flex-1">
        <span className="block text-sm">{setting.label}</span>
        <span className="block text-xs text-muted-foreground">{setting.note} {min}–{max}{setting.unit ? ` ${setting.unit}` : ""}.</span>
      </label>
      <div className="flex items-center gap-2">
        <Input
          id={id}
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          step={1}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
          data-session-collab-number={setting.key}
          className="h-11 w-full md:h-8 md:w-24"
        />
        {setting.unit && <span className="text-xs text-muted-foreground">{setting.unit}</span>}
      </div>
    </div>
  );
}
