import { digestTitle, type DigestProject } from "../../shared/assistant-digest.ts";
import type { NewCard } from "../assistant-cards/assistant-cards.service.ts";
import type { DigestRun } from "./digest-state.ts";

/**
 * The morning digest card, built by PPM from a run: one section per project that was asked, in
 * the order they were asked, answered or not. Items arrive already cleaned and capped by the
 * report tool. Pure, so assembly from partial answers is tested without a store.
 */
export function buildDigestCard(run: DigestRun, titleOnly: (projectKey: string) => boolean): NewCard {
  const projects: DigestProject[] = Object.keys(run.asked).map((key) => {
    const items = run.answers[key];
    return {
      name: run.names[key] ?? "project",
      state: items ? "answered" : "no_answer",
      items: items ?? [],
      ...(titleOnly(key) ? { titleOnly: true } : {}),
    };
  });
  return {
    kind: "digest",
    projectName: null,
    projectPath: null,
    sessionId: null,
    title: digestTitle(projects),
    payload: { date: run.date, projects },
    // The main Assistant session hears of it once, as news.
    wake: true,
  };
}
