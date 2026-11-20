/**
 * A list of words Whisper and the clean-up should know (names, tech terms), as removable chips
 * with an add field. Learned words — corrections PPM picked up from an edited transcript — are
 * drawn apart, with a sparkle and the form that was misheard, and removed on their own.
 */
import { useState } from "react";
import { Plus, Sparkles, X } from "@/lib/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { LearnedWord } from "../../../shared/voice-message";

/** `words` plus `word`, unless it is empty or already there (compared without case). */
export function addVoiceWord(words: readonly string[], word: string): string[] | null {
  const clean = word.replace(/\s+/g, " ").trim();
  if (!clean || words.some((w) => w.toLowerCase() === clean.toLowerCase())) return null;
  return [...words, clean];
}

interface VoiceWordsEditorProps {
  words: string[];
  learned?: LearnedWord[];
  placeholder: string;
  busy?: boolean;
  onWordsChange: (words: string[]) => void;
  onRemoveLearned?: (word: string) => void;
}

export function VoiceWordsEditor({ words, learned = [], placeholder, busy, onWordsChange, onRemoveLearned }: VoiceWordsEditorProps) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const next = addVoiceWord(words, draft);
    setDraft("");
    if (next) onWordsChange(next);
  };
  const empty = words.length === 0 && learned.length === 0;

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-panel">
      <div className="flex flex-wrap gap-1.5 px-3.5 py-3 max-md:gap-y-5">
        {empty && <span className="text-xs text-text-3">No words yet.</span>}
        {learned.map((l) => (
          <span key={`learned-${l.word}`} className="inline-flex items-center gap-1.5 rounded-full border border-accent-2/40 bg-accent-2/10 py-0.5 pl-2.5 pr-1 font-mono text-[12.5px] text-text">
            <Sparkles className="size-3 shrink-0 text-accent-2" aria-label="Learned" />
            {l.word}
            {l.from && <span className="font-sans text-[11px] text-text-3">← {l.from}</span>}
            {onRemoveLearned && <RemoveWord label={`Remove learned word ${l.word}`} disabled={busy} onClick={() => onRemoveLearned(l.word)} />}
          </span>
        ))}
        {words.map((word) => (
          <span key={word} className="inline-flex items-center gap-1 rounded-full border border-border-soft bg-panel-2 py-0.5 pl-2.5 pr-1 font-mono text-[12.5px] text-text">
            {word}
            <RemoveWord label={`Remove ${word}`} disabled={busy} onClick={() => onWordsChange(words.filter((w) => w !== word))} />
          </span>
        ))}
      </div>
      {learned.length > 0 && (
        <p className="flex items-center gap-1.5 px-3.5 pb-2 text-[11.5px] text-text-3">
          <Sparkles className="size-3 text-accent-2" />learned from your corrections
        </p>
      )}
      <form className="flex gap-2 px-3.5 pb-3" onSubmit={(e) => { e.preventDefault(); add(); }}>
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={placeholder}
          aria-label={placeholder}
          disabled={busy}
          className="h-11 md:h-[34px]"
        />
        <Button type="submit" variant="outline" disabled={busy || !draft.trim()} className="h-11 gap-1.5 md:h-[34px]">
          <Plus className="size-3.5" />Add
        </Button>
      </form>
    </div>
  );
}

/** The chip's ×: 18px of ink, 44px tall to a finger through the invisible `::before` (rows are spaced for it). */
function RemoveWord({ label, disabled, onClick }: { label: string; disabled?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="relative grid size-[18px] shrink-0 place-items-center rounded-full text-text-3 transition-colors before:absolute before:-inset-y-3.5 before:-inset-x-1 before:content-[''] can-hover:hover:bg-surface-hover can-hover:hover:text-text disabled:opacity-50 md:before:-inset-1"
    >
      <X className="size-3" />
    </button>
  );
}
