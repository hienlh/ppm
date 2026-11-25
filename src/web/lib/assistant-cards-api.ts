/**
 * PPM Assistant's cards over HTTP: the paged list, the waiting counts, and the user's answers. The
 * server checks every card's kind and status itself; a card answered elsewhere comes back as an
 * error, and the next `assistant:card` event shows who answered it.
 */
import { api, ApiError } from "@/lib/api-client";
import { getDeviceId } from "@/lib/device-id";
import type { AssistantCard, AssistantCardsPage, AssistantWaiting } from "../../shared/assistant-cards";
import type { CardVoiceReply } from "@/lib/card-voice-reply";

export const ASSISTANT_CARD_EVENT = "assistant:card";
export const ASSISTANT_WAITING_EVENT = "assistant:waiting_changed";

export function fetchAssistantCards(q: { before?: number; limit?: number; project?: string } = {}): Promise<AssistantCardsPage> {
  const params = new URLSearchParams();
  if (q.before !== undefined) params.set("before", String(q.before));
  params.set("limit", String(q.limit ?? 30));
  if (q.project) params.set("project", q.project);
  return api.get<AssistantCardsPage>(`/api/assistant/cards?${params}`);
}

/** Every card still waiting on the user, oldest first: the cards behind the waiting counts. */
export const fetchOpenAssistantCards = (): Promise<{ cards: AssistantCard[] }> =>
  api.get<{ cards: AssistantCard[] }>("/api/assistant/cards/open");

export const fetchAssistantWaiting = (): Promise<AssistantWaiting> => api.get<AssistantWaiting>("/api/assistant/waiting");

export function answerAssistantCard(id: string, body: { decision?: "allow" | "deny"; answersById?: Record<string, string[]>; remember?: boolean }) {
  return api.post<{ card: AssistantCard; stale?: true }>(`/api/assistant/cards/${encodeURIComponent(id)}/answer`, body);
}

export const dismissAssistantCard = (id: string) =>
  api.post<{ card: AssistantCard }>(`/api/assistant/cards/${encodeURIComponent(id)}/dismiss`);

/** Brings back a card its author withdrew: it waits on the user again. */
export const restoreAssistantCard = (id: string) =>
  api.post<{ card: AssistantCard }>(`/api/assistant/cards/${encodeURIComponent(id)}/restore`);

/** The user's OK on a needs-decision card, for the exact draft it showed (its hash), or none. */
export const okAssistantCard = (id: string, draftSha256: string | null) =>
  api.post<{ card: AssistantCard; to: "manager" | "assistant"; projectName?: string }>(
    `/api/assistant/cards/${encodeURIComponent(id)}/ok`, { draftSha256, deviceId: getDeviceId() });

/** The user's press on one of a card's choices, named by its id; the server reads the label from the card. */
export const chooseAssistantCardOption = (id: string, optionId: string) =>
  api.post<{ card: AssistantCard; to: "manager" | "assistant"; projectName?: string }>(
    `/api/assistant/cards/${encodeURIComponent(id)}/choose`, { optionId, deviceId: getDeviceId() });

/**
 * The user's own words to a card's manager chat; `force` after the user confirmed a stale card
 * (it is sent even if the card closed meanwhile). `confirmAge` confirms only the card's age: a card
 * someone answered meanwhile is still refused, so a confirmed reply never becomes a second answer.
 * Pictures go as their bytes (base64): the server checks and stores them itself, and takes no path.
 * A spoken reply names its recording with the upload route's receipt (`opts.voice`); `text` is
 * then the transcript.
 */
export const replyToAssistantCard = (
  id: string, text: string, force = false, images: ReadonlyArray<{ data: string; mediaType: string }> = [],
  opts: { confirmAge?: boolean; voice?: CardVoiceReply["voice"] } = {},
) =>
  api.post<{ card: AssistantCard; to: "manager" | "assistant"; projectName?: string }>(
    `/api/assistant/cards/${encodeURIComponent(id)}/reply`, {
      text, ...(force ? { force: true } : {}), ...(opts.confirmAge ? { confirmAge: true } : {}), deviceId: getDeviceId(),
      ...(images.length ? { images: images.map(({ data, mediaType }) => ({ data, mediaType })) } : {}),
      ...(opts.voice ? { voice: opts.voice } : {}),
    });

/** What a refused OK or reply said back: the card as it is now, and a question to ask the user. */
export function cardRefusal(e: unknown): { error: string; question?: string; card?: AssistantCard } {
  const message = e instanceof Error ? e.message : String(e);
  const body = e instanceof ApiError && e.body && typeof e.body === "object" ? (e.body as { data?: { question?: unknown; card?: unknown } }).data : undefined;
  return {
    error: message,
    ...(typeof body?.question === "string" ? { question: body.question } : {}),
    ...(body?.card ? { card: cardFromEvent({ card: body.card }) ?? undefined } : {}),
  };
}

/** A held rules change: approve or revert it, naming the change by its hash (the rules route). */
export const decideRulesChange = (projectName: string, action: "approve" | "revert", hash: string) =>
  api.post<unknown>(`/api/assistant/managers/${encodeURIComponent(projectName)}/rules/decision`, { action, hash });

/** A card from an event's detail, or null when it is not one. */
export function cardFromEvent(detail: unknown): AssistantCard | null {
  const card = detail && typeof detail === "object" ? (detail as { card?: unknown }).card : null;
  if (!card || typeof card !== "object") return null;
  const c = card as AssistantCard;
  return typeof c.id === "string" && typeof c.kind === "string" && typeof c.createdAt === "number" ? c : null;
}
