/**
 * "AI hiểu: BPM → PPM" — the line an AI opens its answer with when it read a word of a voice
 * transcript differently (`src/shared/voice-understood.ts`), drawn as one quiet line above the
 * answer instead of as the answer's first sentence. The same line is what self-learning counts.
 */
import { Sparkles } from "@/lib/icons";
import { formatUnderstoodPairs, splitUnderstoodLine, type UnderstoodPair } from "../../../shared/voice-understood";

export function VoiceUnderstoodLine({ pairs }: { pairs: readonly UnderstoodPair[] }) {
  const text = formatUnderstoodPairs(pairs);
  return (
    <p className="mb-1 flex min-w-0 items-start gap-1.5 text-xs text-text-2" data-voice-understood="" title={`AI hiểu: ${text}`}>
      <Sparkles className="mt-px size-3.5 shrink-0 text-accent-2" />
      <span className="min-w-0 break-words">
        <span className="font-medium">AI hiểu:</span> {text}
      </span>
    </p>
  );
}

/**
 * The answer's text split into its understood line (if it opens with one) and the rest. While the
 * text is still streaming (`complete: false`) the line is split off only once it has ended, so a
 * half-written pair is shown as plain text for a moment rather than as a wrong pair.
 */
export function splitAnswerOpening(text: string, complete = true): { pairs: UnderstoodPair[] | null; rest: string } {
  const split = splitUnderstoodLine(text, { complete });
  return split ? { pairs: split.pairs, rest: split.rest } : { pairs: null, rest: text };
}
