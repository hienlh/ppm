/**
 * The routes Settings → PPM Assistant calls besides the settings row itself: the main session,
 * each project's manager chat and its rules, and the notebook. Every one is under
 * `/api/assistant`, behind PPM's auth; a project is always named, never a path.
 */
import { api } from "@/lib/api-client";
import type { ManagerTelegramDetail } from "../../shared/assistant-managers";
import type { AssistantNote, AssistantNotesView } from "../../shared/assistant-notes";

const managerUrl = (projectName: string) => `/api/assistant/managers/${encodeURIComponent(projectName)}`;

/** What `GET /managers/:project/rules` answers. */
export interface ManagerRulesView {
  approved: string | null;
  /** The file's text in force: the approved rules plus additions PPM accepted. */
  accepted: string | null;
  proposed: string | null;
  pendingHash: string | null;
  approvedAt: number | null;
  addedSince: string[];
  proposedDiff: { added: string[]; removed: string[] } | null;
}

export const setMainSession = (sessionId: string) => api.put<unknown>("/api/assistant/main-session", { sessionId });

export const assignManagerChat = (projectName: string, sessionId: string) => api.put<unknown>(managerUrl(projectName), { sessionId });

export const unassignManagerChat = (projectName: string) => api.del(managerUrl(projectName));

export const patchManagerChat = (projectName: string, patch: { digest?: boolean; telegramDetail?: ManagerTelegramDetail }) =>
  api.patch<unknown>(managerUrl(projectName), patch);

export const createManagerChat = (projectName: string) =>
  api.post<{ sessionId: string; providerId: string; permissionMode: string }>(`${managerUrl(projectName)}/create`, {});

export async function getManagerRules(projectName: string): Promise<ManagerRulesView> {
  return (await api.get<{ rules: ManagerRulesView }>(`${managerUrl(projectName)}/rules`)).rules;
}

export async function putManagerRules(projectName: string, text: string): Promise<ManagerRulesView> {
  return (await api.put<{ rules: ManagerRulesView }>(`${managerUrl(projectName)}/rules`, { text })).rules;
}

export async function decideManagerRules(projectName: string, action: "approve" | "revert", hash: string): Promise<ManagerRulesView> {
  return (await api.post<{ rules: ManagerRulesView }>(`${managerUrl(projectName)}/rules/decision`, { action, hash })).rules;
}

export const listNotes = () => api.get<AssistantNotesView>("/api/assistant/notes");

export const addNote = (text: string) => api.post<{ note: AssistantNote }>("/api/assistant/notes", { text });

export const editNote = (id: number, text: string) => api.patch<{ note: AssistantNote }>(`/api/assistant/notes/${id}`, { text });

export const verifyNote = (id: number) => api.patch<{ note: AssistantNote }>(`/api/assistant/notes/${id}`, { verified: true });

export const deleteNote = (id: number) => api.del(`/api/assistant/notes/${id}`);

/** Bytes as the server counts them (UTF-8), for the 16 KB rules and template counters. */
export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}
