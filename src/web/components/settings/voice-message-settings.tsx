/**
 * Settings → Voice, the voice-message half: the feature's own switch, whether the transcript
 * waits to be read, what the clean-up is, and the word lists Whisper and the clean-up are given
 * (one for every project, one per project with the words PPM learned from your corrections).
 *
 * Every change is saved at once; the server answers with the whole state, which replaces ours.
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { ChevronDown } from "@/lib/icons";
import { SwitchRow } from "./settings-rows";
import { VoiceWordsEditor } from "./voice-words-editor";
import { VoiceSelfLearningSettings } from "./voice-self-learning-settings";
import { useProjectStore } from "@/stores/project-store";
import {
  fetchVoiceSettings, putVoiceSettings, type VoiceSettingsPatch, type VoiceSettingsView,
} from "@/lib/voice-message-client";
import { ASSISTANT_PROJECT_NAME as ASSISTANT_PROJECT, isAssistantProject } from "../../../shared/assistant-project";
import { FEATURE_INTROS_CHANGED_EVENT } from "../../../shared/feature-intros";
import { formatVoiceDuration, VOICE_MAX_SECONDS } from "../../../shared/voice-message";

export function VoiceMessageSettings({ onEnabledChange }: { onEnabledChange?: (enabled: boolean) => void }) {
  const projects = useProjectStore((s) => s.projects);
  const activeProject = useProjectStore((s) => s.activeProject?.name);
  const [project, setProject] = useState<string>(() =>
    (activeProject && !isAssistantProject(activeProject) ? activeProject : projects[0]?.name) ?? ASSISTANT_PROJECT);
  const [view, setView] = useState<VoiceSettingsView | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [busy, setBusy] = useState(false);

  // Read again when the "PPM has new features" question is answered while this pane is open.
  useEffect(() => {
    let live = true;
    const read = () => fetchVoiceSettings(project)
      .then((next) => { if (live) { setView(next); setUnavailable(false); } })
      .catch(() => { if (live) setUnavailable(true); });
    void read();
    window.addEventListener(FEATURE_INTROS_CHANGED_EVENT, read);
    return () => { live = false; window.removeEventListener(FEATURE_INTROS_CHANGED_EVENT, read); };
  }, [project]);

  useEffect(() => { if (view) onEnabledChange?.(view.enabled); }, [view, onEnabledChange]);

  const save = useCallback(async (patch: VoiceSettingsPatch) => {
    setBusy(true);
    try {
      setView(await putVoiceSettings({ project, ...patch }));
    } catch (e) {
      toast.error("Could not save the voice settings", { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }, [project]);

  // A PPM without the voice-message routes has nothing to show here; the rest of the pane stays.
  if (unavailable || !view) return null;

  const projectLabel = project === ASSISTANT_PROJECT ? "PPM Assistant" : project;
  const projectSelect = (
    <label className="relative inline-flex items-center">
      <select
        value={project}
        onChange={(e) => setProject(e.target.value)}
        aria-label="Project"
        className="h-11 appearance-none rounded-lg border border-border bg-panel py-0 pl-2.5 pr-7 text-[12.5px] font-medium normal-case tracking-normal text-text md:h-[30px]"
      >
        {projects.filter((p) => !isAssistantProject(p.name)).map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
        <option value={ASSISTANT_PROJECT}>PPM Assistant</option>
      </select>
      <ChevronDown className="pointer-events-none absolute right-2 size-3 text-text-3" />
    </label>
  );
  return (
    <div className="space-y-6">
      <Group title="Voice messages">
        <SwitchRow
          label="Voice messages"
          note="The mic in the chat box records a message: Whisper turns it into text on this host, then it is tidied for you to read. Off: the mic dictates into the box as before."
          checked={view.enabled}
          disabled={busy}
          onChange={(enabled) => void save({ enabled })}
        />
        {view.enabled && (
          <>
            <SwitchRow
              label="Read the transcript before it is sent"
              note="Off: the transcript goes to the AI as soon as it is ready. When the clean-up fails it always waits for you."
              checked={view.reviewBeforeSend}
              disabled={busy}
              onChange={(reviewBeforeSend) => void save({ reviewBeforeSend })}
            />
            <SwitchRow
              label="Tidy the transcript with Claude Haiku"
              note="One call per message on your Claude account. Reads the last 8 messages, memory and CLAUDE.md, file names and your word lists, and fixes misheard words and punctuation only. It also learns words from your edits. Off: Whisper's transcript is used as it is and Haiku is never called; your word lists still help Whisper."
              checked={view.cleanupEnabled}
              disabled={busy}
              onChange={(cleanupEnabled) => void save({ cleanupEnabled })}
            />
            {view.cleanupEnabled && (
              <SwitchRow
                label="Fix Vietnamese words by context"
                note={'The clean-up also fixes ordinary words Whisper misheard ("ta lệnh" → "ra lệnh") when the sentence makes the meaning clear. The Telegram card lists every word it changed.'}
                checked={view.vietnameseFixes}
                disabled={busy}
                onChange={(vietnameseFixes) => void save({ vietnameseFixes })}
              />
            )}
            <InfoRow label="Longest recording" value={formatVoiceDuration(VOICE_MAX_SECONDS)} />
            {!view.whisperReady && <InfoRow label="Whisper">Not installed on this host yet. Install it below; until then the mic offers the install.</InfoRow>}
          </>
        )}
      </Group>

      {view.enabled && (
        <>
          <Group title="Words · all projects" bare>
            <VoiceWordsEditor
              words={view.words}
              placeholder="Add a word or name…"
              busy={busy}
              onWordsChange={(words) => void save({ words })}
            />
          </Group>
          <Group
            bare
            title={
              <span className="flex items-center gap-2">
                Words · project
                {projectSelect}
              </span>
            }
          >
            <VoiceWordsEditor
              words={view.projectWords}
              // With self-learning on, learned words have their own list (with Undo) further down.
              learned={view.selfLearning ? [] : view.projectLearned}
              placeholder={`Add a word for ${projectLabel}…`}
              busy={busy}
              onWordsChange={(projectWords) => void save({ projectWords })}
              onRemoveLearned={(word) => void save({ removeLearned: [word] })}
            />
          </Group>
          <VoiceSelfLearningSettings view={view} busy={busy} projectSelect={projectSelect} save={(patch) => void save(patch)} />
        </>
      )}
    </div>
  );
}

function Group({ title, children, bare }: { title: ReactNode; children: ReactNode; bare?: boolean }) {
  return (
    <section>
      <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-text-3">{title}</div>
      {bare ? children : <div className="divide-y divide-border-soft overflow-hidden rounded-xl border border-border bg-panel">{children}</div>}
    </section>
  );
}

function InfoRow({ label, value, children }: { label: string; value?: string; children?: ReactNode }) {
  return (
    <div className="flex min-h-11 items-center gap-3 px-4 py-2.5">
      <div className="min-w-0 flex-1">
        <p className="text-sm">{label}</p>
        {children && <p className="text-xs leading-relaxed text-muted-foreground">{children}</p>}
      </div>
      {value && <span className="shrink-0 font-mono text-xs text-text-2">{value}</span>}
    </div>
  );
}
