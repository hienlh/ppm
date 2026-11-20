/**
 * Settings → Voice, the self-learning half: the switch and its parts, what Whisper's prompt holds
 * for the chosen project (word by word, coloured by where each came from), and the learned words
 * with Undo. Every change is saved at once through the pane's `save`, like the rest of Voice.
 */
import type { ReactNode } from "react";
import { SwitchRow } from "./settings-rows";
import { VoiceLearnedWordsList } from "./voice-learned-words-list";
import type { PromptWord, VoiceSettingsPatch, VoiceSettingsView } from "@/lib/voice-message-client";
import { cn } from "@/lib/utils";

const SOURCE_STYLE: Record<PromptWord["source"], { label: string; dot: string; text: string }> = {
  typed: { label: "your words", dot: "bg-warning", text: "text-text" },
  learned: { label: "learned", dot: "bg-accent-2", text: "text-text" },
  picked: { label: "picked up", dot: "bg-primary", text: "text-text-2" },
};

/** The prompt's length as Whisper sees it: the words joined by ", ". */
export const promptChars = (words: readonly PromptWord[]) => words.reduce((n, w, i) => n + w.word.length + (i ? 2 : 0), 0);

export function VoiceSelfLearningSettings({ view, busy, projectSelect, save }: {
  view: VoiceSettingsView;
  busy: boolean;
  /** The pane's project picker, shown beside the per-project parts. */
  projectSelect: ReactNode;
  save: (patch: VoiceSettingsPatch) => void;
}) {
  const on = view.selfLearning;
  return (
    <>
      <Group title="Self-learning">
        <SwitchRow
          label="Learn your words by itself"
          note="Without anyone editing a transcript, PPM picks up names and task codes for Whisper and learns a word once the clean-up has fixed it the same way a few times. Learned words work at once; undo any of them below."
          checked={on}
          disabled={busy}
          onChange={(selfLearning) => save({ selfLearning })}
        />
        {on && (
          <>
            <SwitchRow
              label="Pick up words from the project"
              note="Project and chat names, recent task codes and titles, and CLAUDE.md terms, refreshed once a day. A project gets only its own words; the PPM Assistant gets every project's."
              checked={view.learnAutoVocabulary}
              disabled={busy}
              onChange={(learnAutoVocabulary) => save({ learnAutoVocabulary })}
            />
            <SwitchRow
              label="Learn from the clean-up's corrections"
              note={view.cleanupEnabled
                ? "A word the clean-up fixed the same way in three messages (two when the project already uses it) is learned. No extra Haiku call."
                : "Needs the Haiku clean-up, which is off."}
              checked={view.learnFromCleanup && view.cleanupEnabled}
              disabled={busy || !view.cleanupEnabled}
              onChange={(learnFromCleanup) => save({ learnFromCleanup })}
            />
            <SwitchRow
              label="Weekly summary"
              note="Monday's morning digest lists the words learned that week. It asks nothing; undo here any time."
              checked={view.weeklySummary}
              disabled={busy}
              onChange={(weeklySummary) => save({ weeklySummary })}
            />
          </>
        )}
      </Group>

      {on && (
        <>
          <Group title={<span className="flex flex-wrap items-center gap-2">What Whisper hears first {projectSelect}</span>} bare>
            <PromptPreview words={view.whisperPrompt} max={view.whisperPromptMaxChars} />
          </Group>
          <Group title="Learned words · this project" bare>
            <VoiceLearnedWordsList
              learned={view.projectLearned}
              blocked={view.projectBlocked}
              busy={busy}
              onUndo={(removeLearned) => save({ removeLearned })}
              onRestore={(word) => save({ restoreBlocked: [word] })}
            />
          </Group>
        </>
      )}
    </>
  );
}

function PromptPreview({ words, max }: { words: PromptWord[]; max: number }) {
  const chars = promptChars(words);
  const share = (source: PromptWord["source"]) =>
    words.filter((w) => w.source === source).reduce((n, w) => n + w.word.length + 2, 0) / Math.max(max, 1);
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-panel" data-voice-prompt-preview="">
      <p className="break-words px-4 py-3 font-mono text-xs leading-relaxed">
        {words.length === 0
          ? <span className="text-text-3">Nothing yet: add words above, or wait for the first picked-up list.</span>
          : words.map((w, i) => (
            <span key={`${i}:${w.word}`} className={SOURCE_STYLE[w.source].text}>{w.word}{i < words.length - 1 ? ", " : ""}</span>
          ))}
      </p>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-border-soft px-4 py-2.5 text-xs text-text-2">
        <span className="font-mono">{chars} / {max} characters</span>
        <span className="flex h-1.5 min-w-24 flex-1 overflow-hidden rounded-full bg-panel-2" aria-hidden>
          {(["typed", "learned", "picked"] as const).map((s) => (
            <span key={s} className={cn("h-full", SOURCE_STYLE[s].dot)} style={{ width: `${Math.min(100, share(s) * 100)}%` }} />
          ))}
        </span>
        <span className="flex flex-wrap gap-3">
          {(["typed", "learned", "picked"] as const).map((s) => (
            <span key={s} className="inline-flex items-center gap-1"><span className={cn("size-2 rounded-full", SOURCE_STYLE[s].dot)} />{SOURCE_STYLE[s].label}</span>
          ))}
        </span>
      </div>
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
