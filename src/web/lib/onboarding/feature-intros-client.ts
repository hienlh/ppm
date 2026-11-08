/**
 * The browser half of the tour's "PPM has new features" part: the `/api/feature-intros` calls,
 * a guard for what comes back, and the decision of when the part may show.
 */
import { api } from "@/lib/api-client";
import { isPpmTool } from "../../../shared/ppm-tools";
import type { FeatureIntro, FeatureIntroAnswer, FeatureIntrosView } from "../../../shared/feature-intros";
import type { OnboardingStatus } from "./onboarding-types";

const base = (id: string) => `/api/feature-intros/${encodeURIComponent(id)}`;

function parseIntro(raw: unknown): FeatureIntro | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.id !== "string" || typeof value.title !== "string" || typeof value.body !== "string") return null;
  if (!Array.isArray(value.tools) || !value.tools.every(isPpmTool)) return null;
  return { id: value.id, title: value.title, body: value.body, tools: value.tools, since: typeof value.since === "string" ? value.since : "" };
}

/** The server's answer, or null when it is not one: an unexpected shape shows nothing. */
export function parseFeatureIntrosView(raw: unknown): FeatureIntrosView | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (!Array.isArray(value.pending) || typeof value.isExistingUser !== "boolean") return null;
  const newInSettings = Array.isArray(value.newInSettings) ? value.newInSettings.filter((id): id is string => typeof id === "string") : [];
  return {
    pending: value.pending.map(parseIntro).filter((intro): intro is FeatureIntro => intro !== null),
    isExistingUser: value.isExistingUser,
    newInSettings,
  };
}

export const fetchFeatureIntros = async (): Promise<FeatureIntrosView | null> =>
  parseFeatureIntrosView(await api.get<unknown>("/api/feature-intros"));

export const postFeatureIntroAnswer = (id: string, answer: FeatureIntroAnswer): Promise<unknown> =>
  api.post(`${base(id)}/answer`, { answer });

export const postFeatureIntroSkip = (id: string): Promise<unknown> => api.post(`${base(id)}/skip`);

export const postFeatureIntroSeenInSettings = (id: string): Promise<unknown> => api.post(`${base(id)}/seen-in-settings`);

/**
 * Whether the part may show now. Someone who already uses PPM gets it straight away, whatever
 * this browser's tour says, and the tour is never started for them; a new install waits until
 * its basic tour is finished or dismissed, so the two never compete for the same panel.
 */
export function featurePartAllowed(input: { remaining: number; isExistingUser: boolean; tourStatus: OnboardingStatus; closed: boolean }): boolean {
  if (input.closed || input.remaining === 0) return false;
  return input.isExistingUser || input.tourStatus === "finished" || input.tourStatus === "dismissed";
}
