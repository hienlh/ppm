/**
 * "Template for new manager rules": what a project's `.ppm/manager.md` starts as when it gets a
 * manager chat. Shows PPM's built-in template until the user saves one of their own; saving text
 * equal to the built-in one stores nothing (empty), so a later PPM keeps its template current.
 */
import { useState } from "react";
import { toast } from "sonner";
import { Loader2, RotateCcw } from "@/lib/icons";
import { Button } from "@/components/ui/button";
import { patchAssistantSettings } from "@/lib/assistant-settings-api";
import { utf8Bytes } from "@/lib/assistant-settings-client";
import { RULES_FILE_MAX_BYTES } from "../../../../shared/assistant-limits";
import { AssistantSettingsDialog, DIALOG_BUTTON, DialogActions } from "./assistant-settings-dialog";
import { RulesTextarea, SizeCounter } from "./rules-text-fields";

/** What `manager_template` is stored as for `text`: empty when it is the built-in template. */
export function templateToStore(text: string, builtIn: string): string {
  return text.trim() === builtIn.trim() ? "" : text;
}

export function ManagerTemplateDialog({ template, builtIn, onSaved, onClose }: {
  /** The stored template; empty means the built-in one. */
  template: string;
  builtIn: string;
  onSaved: (stored: string) => void;
  onClose: () => void;
}) {
  const initial = template || builtIn;
  const [text, setText] = useState(initial);
  const [saving, setSaving] = useState(false);
  const bytes = utf8Bytes(text);

  const save = async () => {
    setSaving(true);
    try {
      const res = await patchAssistantSettings({ manager_template: templateToStore(text, builtIn) });
      onSaved(res.settings.manager_template);
      toast.success("Template saved", { description: "New manager chats start from it. Existing rules files stay as they are." });
      onClose();
    } catch (e) {
      toast.error("Could not save the template", { description: e instanceof Error ? e.message : String(e) });
      setSaving(false);
    }
  };

  return (
    <AssistantSettingsDialog open wide title="Template for new manager rules"
      description="Copied into .ppm/manager.md when a project gets a manager chat and has no rules file yet." onClose={onClose}>
      <div className="space-y-3">
        <RulesTextarea label="Template" value={text} disabled={saving} onChange={setText} />
        <SizeCounter bytes={bytes} />
        <DialogActions>
          <Button type="button" variant="outline" disabled={saving || text === builtIn} onClick={() => setText(builtIn)} className={`${DIALOG_BUTTON} gap-1 md:mr-auto`}>
            <RotateCcw className="size-3.5" />Reset to built-in
          </Button>
          <Button type="button" variant="outline" onClick={onClose} className={DIALOG_BUTTON}>Cancel</Button>
          <Button type="button" disabled={saving || bytes > RULES_FILE_MAX_BYTES || text === initial} onClick={() => void save()} className={DIALOG_BUTTON}>
            {saving ? <Loader2 className="size-3.5 animate-spin" /> : "Save"}
          </Button>
        </DialogActions>
      </div>
    </AssistantSettingsDialog>
  );
}
