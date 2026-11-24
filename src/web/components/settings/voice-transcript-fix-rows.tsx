/**
 * Settings → Voice: what each place a voice message is recorded does with Whisper's text before
 * it is sent — the chat box and the PPM Assistant's Telegram bot, chosen apart. "As heard" sends
 * Whisper's text with the words this user's speech was misheard as before, and the AI that reads
 * the message does the guessing; "Claude Haiku" tidies it first, one call and about 3 s a message.
 */
import { cn } from "@/lib/utils";
import type { VoiceSurface, VoiceTranscriptFix } from "../../../shared/voice-message";

const SURFACES: Array<{ surface: VoiceSurface; label: string }> = [
  { surface: "composer", label: "Chat box" },
  { surface: "telegram", label: "Telegram" },
];

const CHOICES: Array<{ value: VoiceTranscriptFix; label: string }> = [
  { value: "hints", label: "As heard, with hints" },
  { value: "haiku", label: "Tidy with Claude Haiku" },
];

export const TRANSCRIPT_FIX_NOTE = "As heard: Whisper's text goes as it is, with the words it misheard for you before attached for the AI that reads it — about 3 s sooner, no extra call. Claude Haiku: one call per message on your Claude account fixes misheard words and punctuation first, reading the last 8 messages, memory, CLAUDE.md and your word lists.";

export function VoiceTranscriptFixRows({ value, disabled, onChange }: {
  value: Record<VoiceSurface, VoiceTranscriptFix>;
  disabled?: boolean;
  onChange: (surface: VoiceSurface, fix: VoiceTranscriptFix) => void;
}) {
  return (
    <div className="space-y-2.5 px-4 py-3" data-testid="voice-transcript-fix">
      <div>
        <p className="text-sm">Misheard words</p>
        <p className="text-xs text-muted-foreground">{TRANSCRIPT_FIX_NOTE}</p>
      </div>
      {SURFACES.map(({ surface, label }) => (
        <div key={surface} className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3">
          <span className="w-20 shrink-0 text-xs font-medium text-text-2">{label}</span>
          <div role="radiogroup" aria-label={`${label}: misheard words`} className="flex min-w-0 flex-1 gap-1.5">
            {CHOICES.map((choice) => {
              const on = value[surface] === choice.value;
              return (
                <button
                  key={choice.value}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  disabled={disabled}
                  data-surface={surface}
                  data-choice={choice.value}
                  onClick={() => { if (!on) onChange(surface, choice.value); }}
                  className={cn(
                    "h-11 min-w-0 flex-1 truncate rounded-lg border px-2.5 text-[12.5px] transition-colors md:h-8",
                    on ? "border-accent-wash-border bg-accent-wash font-medium text-text" : "border-border bg-panel text-text-2 hover:bg-surface-hover",
                    disabled && "cursor-default opacity-60",
                  )}
                >
                  {choice.label}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
