/** Spec mode's REST calls (`/api/project/:name/specs`). */
import { api, projectUrl } from "@/lib/api-client";
import type { SpecView } from "../../shared/spec-view";
import type { SpecChecks, SpecKind, SpecPhase, SpecSummary, SpecWorkflow } from "../../shared/spec-types";

const base = (projectName: string) => `${projectUrl(projectName)}/specs`;
const one = (projectName: string, slug: string) => `${base(projectName)}/${encodeURIComponent(slug)}`;

export interface SpecActionResult {
  message: string;
  spec: SpecView;
}

export const specsApi = {
  list: (projectName: string) => api.get<SpecSummary[]>(base(projectName)),
  get: (projectName: string, slug: string) => api.get<SpecView>(one(projectName, slug)),
  bySession: (projectName: string, sessionId: string) =>
    api.get<{ slug: string; taskId: string | null; providerId: string | null } | null>(`${base(projectName)}/by-session/${encodeURIComponent(sessionId)}`),
  create: (projectName: string, input: { title: string; kind: SpecKind; workflow: SpecWorkflow; checks: SpecChecks; sessionId?: string }) =>
    api.post<SpecView>(base(projectName), input),
  attachSession: (projectName: string, slug: string, sessionId: string) => api.post<SpecView>(`${one(projectName, slug)}/session`, { sessionId }),
  setChecks: (projectName: string, slug: string, checks: SpecChecks) => api.put<SpecView>(`${one(projectName, slug)}/checks`, { checks }),
  approve: (projectName: string, slug: string, phase: SpecPhase | "drawing") =>
    api.post<SpecActionResult>(`${one(projectName, slug)}/approve/${phase}`, { continue: true }),
  requestChanges: (projectName: string, slug: string, phase: SpecPhase | "drawing", note: string) =>
    api.post<SpecView>(`${one(projectName, slug)}/request-changes/${phase}`, { note, continue: true }),
  runTask: (projectName: string, slug: string, taskId: string) => api.post<SpecActionResult>(`${one(projectName, slug)}/tasks/${taskId}/run`, {}),
  resetTask: (projectName: string, slug: string, taskId: string) => api.post<SpecView>(`${one(projectName, slug)}/tasks/${taskId}/reset`, {}),
  checkSuite: (projectName: string, slug: string) => api.post<{ ok: boolean; message: string; spec: SpecView }>(`${one(projectName, slug)}/suite/check`, {}),
  runAll: (projectName: string, slug: string) => api.post<SpecActionResult>(`${one(projectName, slug)}/run`, {}),
  stop: (projectName: string, slug: string) => api.post<SpecActionResult>(`${one(projectName, slug)}/stop`, {}),
};

/** The workflows a new chat offers (Kiro's "Start with a workflow"). */
export type ChatWorkflow = "chat" | "spec" | "quick" | "bugfix";

export interface SpecStartChoice {
  workflow: ChatWorkflow;
  startFrom: "requirements" | "design";
  checks: SpecChecks;
}

export const DEFAULT_SPEC_START: SpecStartChoice = { workflow: "chat", startFrom: "requirements", checks: "standard" };

/** The `spec` body `POST /chat/sessions` takes for a chat started in a spec workflow, or null. */
export function specStartBody(choice: SpecStartChoice, firstMessage: string): { kind: SpecKind; workflow: SpecWorkflow; checks: SpecChecks; title: string } | null {
  if (choice.workflow === "chat") return null;
  const kind: SpecKind = choice.workflow === "spec" ? "feature" : choice.workflow;
  const firstLine = firstMessage.split("\n").find((l) => l.trim())?.trim() ?? "";
  return {
    kind,
    workflow: kind === "feature" && choice.startFrom === "design" ? "design-first" : "requirements-first",
    checks: choice.checks,
    title: firstLine.length > 80 ? `${firstLine.slice(0, 77).trimEnd()}…` : firstLine,
  };
}

/** Reads a stored choice from tab metadata, falling back to the default. */
export function specStartFromMetadata(meta: Record<string, unknown> | undefined): SpecStartChoice {
  const raw = meta?.specStart as Partial<SpecStartChoice> | undefined;
  return {
    workflow: raw?.workflow === "spec" || raw?.workflow === "quick" || raw?.workflow === "bugfix" ? raw.workflow : "chat",
    startFrom: raw?.startFrom === "design" ? "design" : "requirements",
    checks: raw?.checks === "thorough" ? "thorough" : "standard",
  };
}
