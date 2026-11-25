/**
 * After a voice message went out: if the user corrected the transcript PPM gave them, learn the
 * corrected words for the project and say which. Shared by the chat composer and the cards' voice
 * replies. Learning is a bonus; a failure costs the user nothing they sent.
 */
import { toast } from "sonner";
import { openSettings } from "@/components/settings/open-settings";
import { postVoiceLearn } from "@/lib/voice-message-client";
import { transcriptWasEdited } from "@/lib/voice-message-compose";

export function learnFromSentTranscript(project: string | undefined | null, shown: string, sent: string, raw?: string): void {
  if (!project || !transcriptWasEdited(shown, sent, raw)) return;
  void postVoiceLearn({ project, before: shown, after: sent })
    .then((learned) => {
      if (learned.length === 0) return;
      toast.success(`Learned: ${learned.map((l) => l.word).join(", ")}`, {
        action: { label: "Manage", onClick: () => openSettings("voice") },
      });
    })
    .catch(() => { /* nothing to tell the user */ });
}
