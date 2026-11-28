/**
 * Settings → PPM Assistant → Manager chats → Files on cards: the folders, besides a manager's own
 * project folder, it may attach files from on a report card (`report_to_assistant { files }`).
 * One absolute folder per line; private folders inside them (PPM's own, credential stores, `.env`,
 * keys) stay refused by the server whatever is listed here.
 */
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Paperclip, Loader2 } from "@/lib/icons";
import { Button } from "@/components/ui/button";
import { useSettingsChanged } from "@/hooks/use-settings-changed";
import { getAssistantSettings, patchAssistantSettings } from "@/lib/assistant-settings-api";
import { TEXT_BUTTON } from "@/lib/control-size";
import { REPORT_FILE_DIRS_MAX } from "../../../../shared/assistant-settings";
import { SettingLine, SettingsCard } from "./assistant-settings-card";

export const REPORT_FILES_HINT = "A manager can put files from its own project folder on a card (a clip, original "
  + "pictures, a PDF) and they reach your phone with it. List other folders it may use here, one per line.";

/** The lines of the box as folders: trimmed, blank lines dropped, each once. */
export function foldersFromText(text: string): string[] {
  return [...new Set(text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean))];
}

export function AssistantReportFilesSection() {
  const [saved, setSaved] = useState<string[] | null>(null);
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloads, setReloads] = useState(0);
  useSettingsChanged("assistant", () => setReloads((n) => n + 1));

  useEffect(() => {
    let live = true;
    getAssistantSettings()
      .then((res) => {
        if (!live) return;
        const dirs = res.settings.report_file_dirs ?? [];
        setSaved(dirs);
        setText(dirs.join("\n"));
      })
      .catch((e: Error) => { if (live) setError(e.message || "Could not load the Assistant's settings"); });
    return () => { live = false; };
  }, [reloads]);

  if (error) return <p className="text-xs text-error" role="alert">{error}</p>;
  if (!saved) return <div className="flex justify-center py-6 text-muted-foreground"><Loader2 className="size-4 animate-spin" /></div>;

  const wanted = foldersFromText(text);
  const changed = wanted.join("\n") !== saved.join("\n");
  const save = async () => {
    setSaving(true);
    try {
      const res = await patchAssistantSettings({ report_file_dirs: wanted });
      const dirs = res.settings.report_file_dirs ?? [];
      setSaved(dirs);
      setText(dirs.join("\n"));
    } catch (e) {
      toast.error("Could not save", { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div data-testid="assistant-report-files">
      <SettingsCard icon={Paperclip} title="Files on cards">
        <SettingLine label="Other folders managers may attach files from" note={REPORT_FILES_HINT} />
        <div className="space-y-2 px-3.5 pb-3">
          <textarea
            aria-label="Folders managers may attach files from"
            value={text}
            disabled={saving}
            onChange={(e) => setText(e.target.value)}
            rows={Math.min(8, Math.max(3, wanted.length + 1))}
            placeholder={"C:\\Users\\you\\Videos\\renders\n/home/you/exports"}
            spellCheck={false}
            className="w-full resize-y rounded-md border border-border bg-background px-2.5 py-2 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <div className="flex items-center gap-2">
            <Button size="sm" className={TEXT_BUTTON} disabled={!changed || saving || wanted.length > REPORT_FILE_DIRS_MAX} onClick={() => void save()}>
              {saving && <Loader2 className="size-3.5 animate-spin" />} Save folders
            </Button>
            <span className="text-xs text-text-subtle">
              {wanted.length > REPORT_FILE_DIRS_MAX ? `At most ${REPORT_FILE_DIRS_MAX} folders.` : "PPM's own folder, credential stores, .env files and keys are never sent."}
            </span>
          </div>
        </div>
      </SettingsCard>
    </div>
  );
}
