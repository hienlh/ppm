import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { openSettings } from "@/components/settings/open-settings";
import { postVoiceLearn } from "@/lib/voice-message-client";
import {
  decideVoiceSend, shouldAutoSend, transcriptWasEdited, voiceGate,
} from "@/lib/voice-message-compose";
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
  const reviewBeforeSend = draft?.transcript.reviewBeforeSend ?? (view?.reviewBeforeSend !== false);
  const cleaned = draft?.transcript.cleaned ?? false;
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
    (queued: boolean) => decideVoiceSend(gate, { reviewBeforeSend, cleaned, queued }),
    [gate, reviewBeforeSend, cleaned],
  );

  /** After the message carrying the voice went out: drop the draft, keep its upload, learn from edits. */
  const sent = useCallback(() => {
    const shown = draft?.transcript.shown ?? "";
    const final = voicePart()?.transcript ?? "";
    const project = options.project;
    draftSent();
    if (!project || !transcriptWasEdited(shown, final)) return;
    void postVoiceLearn({ project, before: shown, after: final })
      .then((learned) => {
        if (learned.length === 0) return;
        toast.success(`Learned: ${learned.map((l) => l.word).join(", ")}`, {
          action: { label: "Manage", onClick: () => openSettings("voice") },
        });
      })
      .catch(() => { /* Learning is a bonus; a failure costs the user nothing they sent. */ });
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
    autoSendReady: shouldAutoSend(gate, { reviewBeforeSend, cleaned }),
    micBlockedReason,
    remove: draftApi.remove,
    retry: draftApi.retry,
    setText: draftApi.setText,
    voicePart,
    sent,
    whisperDialogOpen,
    closeWhisperDialog: () => setWhisperDialogOpen(false),
  }), [enabled, reviewBeforeSend, recording, recorder.session, stopRecording, recorder.cancel, toggle, draft,
    gate, decide, cleaned, micBlockedReason, draftApi.remove, draftApi.retry, draftApi.setText, voicePart, sent,
    whisperDialogOpen]);
}

export type VoiceMessageComposer = ReturnType<typeof useVoiceMessageComposer>;
