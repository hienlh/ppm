/**
 * PPM Assistant's cards over HTTP: the paged list, the waiting counts, and the user's answers. The
 * server checks every card's kind and status itself; a card answered elsewhere comes back as an
 * error, and the next `assistant:card` event shows who answered it.
 */
import { api } from "@/lib/api-client";
import type { AssistantCard, AssistantCardsPage, AssistantWaiting } from "../../shared/assistant-cards";

export const ASSISTANT_CARD_EVENT = "assistant:card";
export const ASSISTANT_WAITING_EVENT = "assistant:waiting_changed";

export function fetchAssistantCards(q: { before?: number; limit?: number; project?: string } = {}): Promise<AssistantCardsPage> {
  const params = new URLSearchParams();
  if (q.before !== undefined) params.set("before", String(q.before));
  params.set("limit", String(q.limit ?? 30));
  if (q.project) params.set("project", q.project);
  return api.get<AssistantCardsPage>(`/api/assistant/cards?${params}`);
}

export const fetchAssistantWaiting = (): Promise<AssistantWaiting> => api.get<AssistantWaiting>("/api/assistant/waiting");

export function answerAssistantCard(id: string, body: { decision?: "allow" | "deny"; answersById?: Record<string, string[]> }) {
  return api.post<{ card: AssistantCard; stale?: true }>(`/api/assistant/cards/${encodeURIComponent(id)}/answer`, body);
}

export const dismissAssistantCard = (id: string) =>
  api.post<{ card: AssistantCard }>(`/api/assistant/cards/${encodeURIComponent(id)}/dismiss`);

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
