/**
 * The I/O half of the session review: the chat routes, the events that keep an open Review
 * tab and the changes bar in step with each other, and opening that tab.
 */
import { api, projectUrl } from "@/lib/api-client";
import { useTabStore } from "@/stores/tab-store";
import { patchTabMetadata } from "@/lib/patch-tab-metadata";
import type {
  SessionAnswer,
  SessionAnswerFile,
  SessionAnswerResult,
  SessionFileChange,
  SessionFileDiff,
  SessionReviewResult,
  TurnRevertResult,
} from "../../shared/session-file-changes";

function changesUrl(projectName: string, sessionId: string): string {
  return `${projectUrl(projectName)}/chat/sessions/${encodeURIComponent(sessionId)}/file-changes`;
}

/** Every file the session changed; `paths` adds the ones the transcript names. */
export async function fetchSessionFileChanges(
  projectName: string,
  sessionId: string,
  paths: string[],
  signal?: AbortSignal,
): Promise<SessionFileChange[]> {
  const res = await api.post<{ files?: SessionFileChange[] }>(changesUrl(projectName, sessionId), { paths }, { signal });
  // The bar renders inside every chat tab: an answer of any other shape must not take it down.
  return Array.isArray(res?.files) ? res.files : [];
}

export function fetchSessionFileDiff(
  projectName: string,
  sessionId: string,
  path: string,
  signal?: AbortSignal,
): Promise<SessionFileDiff> {
  return api.get<SessionFileDiff>(`${changesUrl(projectName, sessionId)}/diff?path=${encodeURIComponent(path)}`, { signal });
}

/**
 * Mark files reviewed, or unmark them. Each goes with the version it was shown at: the server
 * leaves a file that has changed since, rather than hide a change nobody has read.
 */
export function setSessionFilesReviewed(
  projectName: string,
  sessionId: string,
  files: SessionFileChange[],
  reviewed: boolean,
): Promise<SessionReviewResult> {
  return api.post<SessionReviewResult>(`${changesUrl(projectName, sessionId)}/reviewed`, {
    files: files.map((f) => ({ path: f.path, version: f.version })),
    reviewed,
  });
}

/**
 * Keep blocks, open them again, or revert them on disk — every block of a file whose `keys` are
 * absent. Each file goes with the version it was drawn at; the server leaves one that moved on.
 */
export function answerSessionChanges(
  projectName: string,
  sessionId: string,
  answer: SessionAnswer,
  files: SessionAnswerFile[],
): Promise<SessionAnswerResult> {
  return api.post<SessionAnswerResult>(`${changesUrl(projectName, sessionId)}/answer`, { answer, files });
}

/**
 * What reverting a turn would put back, worked out from the session's history; with `apply`
 * (each file at the version shown) it is written, or nothing is when one moved on (`stale`).
 */
export function revertSessionTurn(
  projectName: string,
  sessionId: string,
  calls: string[],
  apply?: { path: string; version: string }[],
): Promise<TurnRevertResult> {
  return api.post<TurnRevertResult>(`${changesUrl(projectName, sessionId)}/revert-turn`, { calls, ...(apply ? { apply } : {}) });
}

/** Undo an answer: every file it touched, or none of them (`stale`). */
export function undoSessionAnswer(projectName: string, sessionId: string, undoId: string): Promise<SessionAnswerResult> {
  return api.post<SessionAnswerResult>(`${changesUrl(projectName, sessionId)}/undo`, { undoId });
}

/**
 * Fired on `window` once a Review tab has saved marks, so the changes bar of the same session
 * asks again: the bar does not hear the tab's own lists.
 */
export const SESSION_REVIEW_MARKS_EVENT = "ppm:session-review-marks";

export function announceReviewMarks(detail: { projectName: string; sessionId: string }): void {
  window.dispatchEvent(new CustomEvent(SESSION_REVIEW_MARKS_EVENT, { detail }));
}

/**
 * Fired on `window` each time the changes bar gets a fresh list, so a Review tab open on the
 * same session follows along without asking the server itself.
 */
export const SESSION_CHANGES_EVENT = "ppm:session-file-changes";

export interface SessionChangesEventDetail {
  projectName: string;
  sessionId: string;
  files: SessionFileChange[];
  paths: string[];
  /** `performance.now()` when the list was asked for: one asked before an answer landed is out of date. */
  askedAt: number;
}

export function announceSessionChanges(detail: SessionChangesEventDetail): void {
  window.dispatchEvent(new CustomEvent<SessionChangesEventDetail>(SESSION_CHANGES_EVENT, { detail }));
}

/**
 * Open (or focus) the session's Review tab, on `selectPath` when given. An open tab is only
 * focused by `openTab`, so what changed since is written into it afterwards — the transcript
 * paths, and the file to show.
 */
export function openSessionReview(p: {
  projectName: string;
  sessionId: string;
  title?: string;
  /** Which agent ran the session: what its shell commands left out of the list depends on it. */
  providerId?: string;
  paths: string[];
  selectPath?: string;
}): void {
  const patch = {
    paths: p.paths,
    // The header links back to the chat by its name, which can change after the tab opened.
    ...(p.title ? { chatTitle: p.title } : {}),
    // A new object each time: asking for the same file again must still select it.
    select: p.selectPath ? { path: p.selectPath, at: Date.now() } : undefined,
  };
  const id = useTabStore.getState().openTab({
    type: "session-review",
    title: p.title ? `Changes: ${p.title}` : "Session changes",
    projectId: p.projectName,
    closable: true,
    metadata: { projectName: p.projectName, sessionId: p.sessionId, providerId: p.providerId, ...patch },
  });
  if (id) patchTabMetadata(id, patch);
}
