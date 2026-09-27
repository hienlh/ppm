import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Loader2 } from "@/lib/icons";
import { useProjectStore } from "@/stores/project-store";
import type { SlashItem } from "@/components/chat/slash-command-picker";
import {
  getDesignSettings, readSkillLists, saveDesignInstructions, type DesignSettings,
} from "@/lib/design/api-design-settings";
import { DesignSkillSuggestionCard } from "@/components/design/design-skill-suggestion";
import { extractSkillMentions, utf8ByteLength } from "../../../shared/design-skill-mentions";
import { needsDesignSkillSuggestion } from "../../../shared/design-skill-suggestion";
import { DesignInstructionsEditor } from "./design-instructions-editor";
import { DesignSkillMentionStatus } from "./design-skill-mention-status";

/** One picker list across providers; the first provider's copy of a shared name wins. */
function mergeSkills(settings: DesignSettings): SlashItem[] {
  const seen = new Set<string>();
  const merged: SlashItem[] = [];
  for (const provider of settings.providers) {
    for (const item of provider.items) {
      if (seen.has(item.name)) continue;
      seen.add(item.name);
      merged.push(item);
    }
  }
  return merged;
}

/**
 * Settings → Design: the owner's own instructions for every design session, global to all
 * projects. The active project only adds its own skills to the picker.
 */
export function DesignSettingsSection() {
  const projectName = useProjectStore((s) => s.activeProject?.name);
  const [settings, setSettings] = useState<DesignSettings | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // The text last loaded or saved, so a reload for another project (which only changes
  // the skill lists) can tell an untouched draft from one the user is still editing.
  const savedRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoadError(null);
    // Fresh lists: this pane is where a user comes right after installing a skill.
    getDesignSettings(projectName, { fresh: true })
      .then((next) => {
        if (cancelled) return;
        const previous = savedRef.current;
        savedRef.current = next.instructions;
        setSettings(next);
        setDraft((draft) => (previous === null || draft.trim() === previous ? next.instructions : draft));
      })
      .catch((e: Error) => { if (!cancelled) setLoadError(e.message || "Could not load design settings"); });
    return () => { cancelled = true; };
  }, [projectName]);

  const skills = useMemo(() => (settings ? mergeSkills(settings) : []), [settings]);
  const mentions = useMemo(() => extractSkillMentions(draft), [draft]);
  const bytes = useMemo(() => utf8ByteLength(draft.trim()), [draft]);

  if (loadError) return <p className="text-xs text-destructive" role="alert">{loadError}</p>;
  if (!settings) {
    return (
      <div className="flex items-center justify-center py-8 text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
      </div>
    );
  }

  const tooLong = bytes > settings.maxBytes;
  const dirty = draft.trim() !== settings.instructions;
  // Only lists that were read can show nothing is installed; with none read, say nothing.
  const readLists = readSkillLists(settings);
  const suggest = readLists.length > 0 && needsDesignSkillSuggestion(draft, readLists);

  const save = async () => {
    setSaving(true);
    try {
      const instructions = await saveDesignInstructions(draft);
      savedRef.current = instructions;
      setSettings({ ...settings, instructions });
      setDraft(instructions);
      toast.success("Design instructions saved");
    } catch (e) {
      toast.error("Could not save", { description: (e as Error).message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <p className="text-sm font-medium">Design instructions</p>
        <p className="text-xs leading-relaxed text-text-subtle">
          Added to every design chat, in every project, after PPM's own design rules — which
          still come first. Name an installed skill with <code>/</code> and the AI is told to use
          it before designing. Changes apply to design chats started after saving; a chat that
          is already open may keep the old instructions until it is reopened.
        </p>
      </div>

      <DesignInstructionsEditor value={draft} onChange={setDraft} skills={skills} disabled={saving} />

      <div className="flex items-center justify-between gap-2">
        <span className={tooLong ? "text-xs text-destructive" : "text-xs text-text-subtle"}>
          {bytes.toLocaleString()} / {settings.maxBytes.toLocaleString()} bytes
        </span>
        <Button size="sm" className="min-h-11 px-4 text-xs md:min-h-8" disabled={!dirty || tooLong || saving} onClick={save}>
          {saving ? <Loader2 className="size-3.5 animate-spin" /> : "Save"}
        </Button>
      </div>

      <DesignSkillMentionStatus mentions={mentions} providers={settings.providers} />
      {!settings.providers.length && (
        <p className="text-xs text-text-subtle">No configured provider can run design chats. Enable Claude or Codex in AI Provider.</p>
      )}
      {suggest && <DesignSkillSuggestionCard />}
    </div>
  );
}
