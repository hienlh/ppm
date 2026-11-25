import { useCallback, useMemo, useState } from "react";
import { decideVoiceSend, shouldAutoSend, voiceGate } from "@/lib/voice-message-compose";
import { learnFromSentTranscript } from "@/lib/voice-learn-after-send";
import { useVoiceMessageSettings } from "./use-voice-message-settings";
import { useVoiceMessageDraft, type VoiceDraftDeps } from "./use-voice-message-draft";
import { useVoiceMessageRecorder } from "./use-voice-message-recorder";

export type VoiceComposerOptions = Omit<VoiceDraftDeps, "onWhisperMissing">;

/**
 * Everything the composer needs for voice messages, behind one hook so the composer itself only
 * wires buttons to it: the settings (is the feature on, does the transcript wait for review),
 * the recorder, the draft and the "Whisper is not installed" dialog.
 *
 * `enabled` is false whenever the feature is off, has not been read yet, or this browser cannot
 * record (no `mediaDevices` on plain HTTP); the composer then behaves exactly as it did before.
 */
export function useVoiceMessageComposer(options: VoiceComposerOptions) {
  const { view, refresh } = useVoiceMessageSettings(options.project);
  const [whisperDialogOpen, setWhisperDialogOpen] = useState(false);
  const draftApi = useVoiceMessageDraft({ ...options, onWhisperMissing: () => setWhisperDialogOpen(true) });
  const recorder = useVoiceMessageRecorder(draftApi.begin);
  const { draft, voicePart, sent: draftSent } = draftApi;
  const { recording, start: startRecording, stop: stopRecording } = recorder;

  const enabled = view?.enabled === true && recorder.supported && !!options.project;
  // The plain setting (the server's answer is fresher than the one read at mount). A raw
  // transcript's hold comes from `cleaned`, never from this flag.
  const reviewBeforeSend = draft?.transcript.reviewBeforeSend ?? (view?.reviewBeforeSend !== false);
  // A transcript the user chose not to have tidied is as good as a tidied one for sending: only a
  // failed clean-up forces a review.
  const cleaned = (draft?.transcript.cleaned || draft?.transcript.cleanupSkipped) ?? false;
  const transcriptBlank = draft?.transcript.status === "ready" && draftApi.blank;
  const gate = voiceGate(draft
    ? { transcript: draft.transcript.status, upload: draft.upload.status, cleaned }
    : null);

  /** The mic button and the Cmd+Shift+V shortcut: start, or finish the recording in progress. */
  const toggle = useCallback(async () => {
    if (recording) { stopRecording(); return; }
    // One voice per message; the button is disabled, the shortcut lands here.
    if (draft) return;
    // Whisper may have been installed since the settings were read.
    const current = view?.whisperReady ? view : await refresh();
    if (!current?.whisperReady) { setWhisperDialogOpen(true); return; }
    await startRecording();
  }, [recording, stopRecording, startRecording, draft, view, refresh]);

  const decide = useCallback(
    () => decideVoiceSend(gate, { reviewBeforeSend, cleaned, transcriptBlank }),
    [gate, reviewBeforeSend, cleaned, transcriptBlank],
  );

  /** After the message carrying the voice went out: drop the draft, keep its upload, learn from edits. */
  const sent = useCallback(() => {
    const shown = draft?.transcript.shown ?? "";
    const final = voicePart()?.transcript ?? "";
    draftSent();
    learnFromSentTranscript(options.project, shown, final, draft?.transcript.raw);
  }, [draft, voicePart, draftSent, options.project]);

  const micBlockedReason = draft ? "One voice message per message. Remove this one to record another." : null;

  return useMemo(() => ({
    enabled,
    reviewBeforeSend,
    recording,
    session: recorder.session,
    stopRecording,
    cancelRecording: recorder.cancel,
    toggle,
    draft,
    gate,
    decide,
    transcriptBlank,
    autoSendReady: shouldAutoSend(gate, { reviewBeforeSend, cleaned }),
    micBlockedReason,
    remove: draftApi.remove,
    restore: draftApi.restore,
    detach: draftApi.detach,
    retry: draftApi.retry,
    setText: draftApi.setText,
    voicePart,
    sent,
    whisperDialogOpen,
    closeWhisperDialog: () => setWhisperDialogOpen(false),
  }), [enabled, reviewBeforeSend, recording, recorder.session, stopRecording, recorder.cancel, toggle, draft,
    gate, decide, transcriptBlank, cleaned, micBlockedReason, draftApi.remove, draftApi.restore, draftApi.detach, draftApi.retry, draftApi.setText, voicePart, sent,
    whisperDialogOpen]);
}

export type VoiceMessageComposer = ReturnType<typeof useVoiceMessageComposer>;
