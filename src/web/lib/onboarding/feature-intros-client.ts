/**
 * The browser half of the tour's "PPM has new features" part: the `/api/feature-intros` calls,
 * a guard for what comes back, and the decision of when the part may show.
 */
import { api } from "@/lib/api-client";
import { isPpmTool } from "../../../shared/ppm-tools";
import type { FeatureIntro, FeatureIntroAnswer, FeatureIntroSetting, FeatureIntrosView } from "../../../shared/feature-intros";
import type { OnboardingStatus } from "./onboarding-types";

const base = (id: string) => `/api/feature-intros/${encodeURIComponent(id)}`;

const KNOWN_SETTINGS: readonly FeatureIntroSetting[] = ["assistant_permission_mode", "voice_messages", "voice_self_learning"];
const isKnownSetting = (value: unknown): value is FeatureIntroSetting =>
  typeof value === "string" && (KNOWN_SETTINGS as readonly string[]).includes(value);

/**
 * Where a feature's own switch lives in Settings, for the step's "decide there instead" link. A
 * feature made of tool switches is decided in Tools; a feature that is one setting, on its pane.
 */
export function featureIntroSettingsLink(intro: Pick<FeatureIntro, "setting">): { category: "tools" | "assistant" | "voice"; label: string } {
  if (intro.setting === "voice_messages" || intro.setting === "voice_self_learning") {
    return { category: "voice", label: "Choose in Settings → Voice Input instead" };
  }
  if (intro.setting === "assistant_permission_mode") return { category: "assistant", label: "Choose in Settings → PPM Assistant instead" };
  return { category: "tools", label: "Change single tools in Settings → Tools" };
}

function parseIntro(raw: unknown): FeatureIntro | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.id !== "string" || typeof value.title !== "string" || typeof value.body !== "string") return null;
  if (!Array.isArray(value.tools) || !value.tools.every(isPpmTool)) return null;
  // A feature that is one setting keeps it: the step links to where that setting lives.
  const setting = isKnownSetting(value.setting) ? { setting: value.setting } : {};
  return { id: value.id, title: value.title, body: value.body, tools: value.tools, ...setting, since: typeof value.since === "string" ? value.since : "" };
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

/** The basic tour is under way in this browser: being set up, running, or paused (a reload pauses a running tour). */
const TOUR_IN_PROGRESS: readonly OnboardingStatus[] = ["choosing", "active", "paused"];

/**
 * Whether the part may show now. A basic tour under way in this browser always goes first, for
 * any install: "existing user" is the server's word and turns true as soon as the new user sends
 * the tour's own chat, so on its own it would put this part on top of a tour still running after
 * a reload. Otherwise someone who already uses PPM gets it straight away (the tour is never
 * started for them), and a new install waits until its basic tour is finished or dismissed.
 */
export function featurePartAllowed(input: { remaining: number; isExistingUser: boolean; tourStatus: OnboardingStatus; closed: boolean }): boolean {
  if (input.closed || input.remaining === 0) return false;
  if (TOUR_IN_PROGRESS.includes(input.tourStatus)) return false;
  return input.isExistingUser || input.tourStatus === "finished" || input.tourStatus === "dismissed";
}
