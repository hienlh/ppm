/**
 * Sentences Whisper invents when it is handed audio with no speech in it.
 *
 * The model was trained on YouTube subtitles, so the likeliest continuation of
 * "a Vietnamese clip with nothing being said" is that channel's sign-off — and
 * it is not a rare edge case: with `--vad` off, *every* non-speech clip
 * measured on large-v3-turbo (digital silence, white noise at four levels,
 * 50 Hz hum, a 440 Hz tone, brown noise, keyboard clicks, a cough, a breath)
 * came back as the same one sentence, byte for byte:
 *
 *     silence/noise/hum/tone/typing/cough  →  "Hãy subscribe cho kênh Ghiền Mì
 *                                              Gõ Để không bỏ lỡ những video hấp dẫn"
 *     room tone                            →  "Cảm ơn các bạn đã theo dõi và hẹn gặp lại."
 *
 * The VAD model is what normally stops this (those same clips come back empty
 * with it on), so this list is the second line of defence for the audio VAD
 * does let through — a fan, a distant TV, a word spoken too far from the mic.
 * It is deliberately short and measured rather than guessed: add a sentence
 * here only after seeing this model produce it from a clip with no speech.
 */

/** Same shape as the list: lowercased, punctuation dropped, spaces collapsed. */
function normalize(line: string): string {
  return line
    .toLowerCase()
    .replace(/[.,!?;:"'`*\-_()[\]…]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const INVENTED = [
  "Hãy subscribe cho kênh Ghiền Mì Gõ Để không bỏ lỡ những video hấp dẫn",
  "Cảm ơn các bạn đã theo dõi và hẹn gặp lại.",
].map(normalize);

/**
 * The channel name is the fingerprint: the sign-off comes back with small
 * wording changes, and nobody dictating into a chat box says it at all.
 */
const FINGERPRINT = normalize("Ghiền Mì Gõ");

/**
 * True for a whole segment the model made up. Whole lines only — `-nt` prints
 * one line per segment, so dropping a line drops exactly the invented
 * sentence and leaves the real ones either side of it alone.
 */
export function isInventedLine(line: string): boolean {
  const normalized = normalize(line);
  if (normalized.length === 0) return false;
  return INVENTED.includes(normalized) || normalized.includes(FINGERPRINT);
}
