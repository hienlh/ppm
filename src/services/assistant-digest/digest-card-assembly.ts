import {
  DIGEST_RESURFACED_MAX, digestTitle, type DigestProject, type DigestResurfacedTask, type DigestVoiceLearned,
} from "../../shared/assistant-digest.ts";
import type { NewCard } from "../assistant-cards/assistant-cards.service.ts";
import type { DigestRun } from "./digest-state.ts";

/** A project's waiting tasks as the digest lists them, read by PPM from its task store. */
export type DigestWaitingOf = (projectKey: string) => Pick<DigestProject, "waiting" | "waitingMore" | "waitingMine">;

/**
 * The morning digest card, built by PPM from a run: one section per project that was asked, in
 * the order they were asked, answered or not, and PPM's own list of tasks back from a snooze
 * that day. Items arrive already cleaned and capped by the report tool; each section also lists
 * the project's waiting tasks (`waitingOf`), which PPM reads itself. Pure, so assembly from
 * partial answers is tested without a store.
 */
export function buildDigestCard(
  run: DigestRun, titleOnly: (projectKey: string) => boolean, waitingOf?: DigestWaitingOf,
  resurfaced: readonly DigestResurfacedTask[] = [],
  voiceLearned: readonly DigestVoiceLearned[] = [],
): NewCard {
  const projects: DigestProject[] = Object.keys(run.asked).map((key) => {
    const items = run.answers[key];
    let waiting: ReturnType<DigestWaitingOf> = {};
    try { waiting = waitingOf?.(key) ?? {}; } catch { /* the task store unreadable: the section keeps the manager's items */ }
    return {
      name: run.names[key] ?? "project",
      state: items ? "answered" : "no_answer",
      items: items ?? [],
      ...(titleOnly(key) ? { titleOnly: true } : {}),
      ...waiting,
    };
  });
  return {
    kind: "digest",
    projectName: null,
    projectPath: null,
    sessionId: null,
    title: digestTitle(projects),
    payload: {
      date: run.date, projects,
      ...(resurfaced.length ? { resurfaced: resurfaced.slice(0, DIGEST_RESURFACED_MAX) } : {}),
      ...(voiceLearned.length ? { voiceLearned: [...voiceLearned] } : {}),
    },
    // The main Assistant session hears of it once, as news.
    wake: true,
  };
}
