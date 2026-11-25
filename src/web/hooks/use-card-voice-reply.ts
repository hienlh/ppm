/**
 * A voice reply to one of the PPM Assistant's cards: the chat composer's own voice flow
 * (`useVoiceMessageComposer` — Whisper on the host, the tidy-up, the misheard-word hints, learning
 * from an edit, "Read the transcript before sending"), pointed at the card's manager chat.
 *
 * The recording goes through PPM's upload route like any composer recording; the route's receipt
 * travels with the reply, since that is what the server asks for before it calls a reply spoken.
 * Sending, queueing a press while the transcript is still coming and the auto-send with review off
 * are decided by the same functions the composer uses (`voice-message-compose.ts`); only `send` —
 * which route the words take — belongs to the card.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { discardChatUpload, uploadChatFile } from "@/lib/chat-upload-client";
import { autoSendStep } from "@/lib/voice-message-compose";
import { cardVoiceReply, type CardVoiceReply } from "@/lib/card-voice-reply";
import { useVoiceMessageComposer } from "./use-voice-message-composer";
import type { AssistantCard } from "../../shared/assistant-cards";

/** The card a reply answers, as far as the voice flow needs it. */
export interface CardVoiceTarget {
  projectName: string | null;
  /** The manager chat (or mirrored chat) the card came from: the tidy-up reads its last messages. */
  sessionId: string | null;
  /** That chat's provider; a manager chat is a Claude chat. */
  providerId?: string;
}

/** The voice target of a card. */
export const cardVoiceTarget = (card: Pick<AssistantCard, "projectName" | "sessionId" | "payload">): CardVoiceTarget => ({
  projectName: card.projectName, sessionId: card.sessionId, ...(card.payload.chat ? { providerId: card.payload.chat.providerId } : {}),
});

export interface CardVoiceReplyOptions {
  card: CardVoiceTarget | null;
  /** What is typed in the card's field: the tidy-up reads it as context. */
  getTyped: () => string;
  /** Sends the reply; it reads `reply()` itself, and calls `sent()` once the words went. */
  send: () => void;
  /** The card cannot send right now (busy, closed): an auto-send waits for it. */
  blocked: boolean;
}

export function useCardVoiceReply({ card, getTyped, send, blocked }: CardVoiceReplyOptions) {
  const project = card?.projectName ?? undefined;
  const providerId = card?.providerId ?? "claude";
  const receipts = useRef(new Map<string, string>());
  const uploadFile = useCallback(async (file: File) => {
    if (!project) return null;
    const uploaded = await uploadChatFile(project, file);
    if (uploaded?.voiceReceipt) receipts.current.set(uploaded.path, uploaded.voiceReceipt);
    return uploaded?.path ?? null;
  }, [project]);
  const discardUpload = useCallback(async (path: string) => {
    receipts.current.delete(path);
    if (project) await discardChatUpload(project, path);
  }, [project]);

  const voice = useVoiceMessageComposer({
    project, sessionId: card?.sessionId ?? undefined, providerId, getTyped, uploadFile, discardUpload,
  });
  // Only a card with a manager chat takes words from here, so only such a card offers the mic.
  const enabled = voice.enabled && !!card?.sessionId;

  const sendRef = useRef(send);
  sendRef.current = send;
  const [queued, setQueued] = useState(false);

  /** The reply as the card's route takes it, or null when there is no ready voice to send. */
  const reply = useCallback((): CardVoiceReply | null => {
    const part = voice.voicePart();
    return part ? cardVoiceReply(part, receipts.current.get(part.path)) : null;
  }, [voice.voicePart]);

  const notSendable = () => toast.error("This voice message cannot be sent", { description: "Retry the part that failed, or remove it and record again." });

  /** Send pressed (or Enter): the composer's own decision about the voice draft. */
  const requestSend = useCallback(() => {
    if (voice.recording) return;
    const decision = voice.decide();
    if (decision === "refuse") { notSendable(); return; }
    if (decision === "hold") return;
    // Pressed while it is being transcribed: it goes when ready; pressing again cancels.
    if (decision === "queue") { setQueued((q) => !q); return; }
    sendRef.current();
  }, [voice.recording, voice.decide]);

  useEffect(() => {
    if (!queued) return;
    const decision = voice.decide();
    if (decision === "queue") return;
    setQueued(false);
    if (decision === "send") sendRef.current();
    else if (decision === "refuse") notSendable();
  }, [queued, voice.decide]);

  // With review off, a tidied transcript sends the reply by itself, once per recording.
  const [autoSentId, setAutoSentId] = useState<string | null>(null);
  useEffect(() => {
    const id = voice.draft?.id ?? null;
    const step = autoSendStep({ ready: voice.autoSendReady, draftId: id, attemptedId: autoSentId, queued, blocked: blocked || voice.recording });
    if (step !== "send") return;
    setAutoSentId(id);
    sendRef.current();
  }, [voice.autoSendReady, voice.draft?.id, autoSentId, queued, blocked, voice.recording]);
  // An auto-send that did not go (the card asked "send anyway?", a failure) leaves it for the user.
  const stalled = !!voice.draft && autoSentId === voice.draft.id && !queued;

  // A draft removed drops its queued press with it.
  useEffect(() => { if (!voice.draft) setQueued(false); }, [voice.draft]);

  return { ...voice, enabled, reply, requestSend, queued, stalled };
}

export type CardVoiceReplyApi = ReturnType<typeof useCardVoiceReply>;
