/**
 * New PPM features introduced inside the onboarding tour, each asked once per install: turn it on
 * or turn it off. Adding a feature means adding an entry to `FEATURE_INTROS`; the tour, the
 * server routes and the tool defaults all read this list.
 *
 * A feature's tool switches are off until the user decides (`ppmToolOn` in `ppm-tools.ts`), and a
 * decision is always stored as explicit switches: Turn on / Turn off writes every tool of the
 * feature, and a switch flipped in Settings → Tools writes the feature's other tools at their
 * current state first (`patchPpmToolSwitches`). So `ai.ppm_tools` alone says whether a tool is
 * on, and every path that reads it (chat token minting, the MCP endpoints, Claude and Codex
 * options, the CLI) agrees with no extra state to pass around. The only way to have some of a
 * feature's switches set and others missing is a setting saved before the feature was
 * introduced; there the missing ones follow the set ones — on if any set one is on
 * (`answerFromSwitches`), which is also the answer recorded for a feature decided in Settings.
 *
 * A feature that is an editor setting rather than AI tools names a `uiPref` instead (and no
 * tools): the answer is that boolean in the `ui_prefs` row, unset means off, and the switch for it
 * in Settings, once saved, is the answer (`answerFromUiPrefs`).
 */
import type { PpmTool, PpmToolSwitches } from "./ppm-tools.ts";
import { SESSION_HISTORY_TOOLS } from "./session-history-tools.ts";
import { SESSION_COLLAB_TOOLS } from "./session-collab.ts";
import { SESSION_SCHEDULE_PROPOSE_SCRIPT_TOOL, SESSION_SCHEDULE_TOOLS } from "./session-schedule-tools.ts";

export interface FeatureIntro {
  /** Stable for the life of the install: the answer is stored under it. */
  id: string;
  title: string;
  /** Two to four short sentences. */
  body: string;
  /** The Settings → Tools switches the answer sets; empty for a feature that is a `uiPref`. */
  tools: readonly PpmTool[];
  /** The `ui_prefs` boolean the answer sets, for a feature that is an editor setting, not AI tools. */
  uiPref?: FeatureUiPref;
  /** When the feature arrived, for the record. */
  since: string;
}

/** The `ui_prefs` booleans a feature introduction may decide. Off while unset. */
export const FEATURE_UI_PREFS = ["gutterChanges"] as const;
export type FeatureUiPref = typeof FEATURE_UI_PREFS[number];
export const isFeatureUiPref = (value: unknown): value is FeatureUiPref => (FEATURE_UI_PREFS as readonly unknown[]).includes(value);

export const FEATURE_INTROS: readonly FeatureIntro[] = [
  {
    id: "session-tools-2026-11",
    title: "Sessions that read and message each other",
    body: "The AI can search this project's other chats and read their turns, open new PPM sessions to hand work to, "
      + "and message any session of the project. Everything it does shows up in PPM, where you can open or stop it. "
      + "It stays off until you choose.",
    tools: [...SESSION_HISTORY_TOOLS, ...SESSION_COLLAB_TOOLS],
    since: "2026-11",
  },
  {
    // A question of its own: an install that turned the tools above on must not get these silently.
    id: "session-schedules-2026-11",
    title: "Scheduled prompts in a chat",
    body: "The AI can schedule a prompt into its own chat — every morning, or once at a set time — and list or delete "
      + "those schedules. They survive restarts and are delivered once the chat is idle; Settings → Schedules lists "
      + "them. It stays off until you choose.",
    tools: SESSION_SCHEDULE_TOOLS.filter((t) => t !== SESSION_SCHEDULE_PROPOSE_SCRIPT_TOOL),
    since: "2026-11",
  },
  {
    // A question of its own: turning prompts on never agreed to code that runs on this machine.
    id: "script-schedule-proposals-2026-11",
    title: "Script schedules the AI proposes",
    body: "The AI can propose a script schedule for its project: code PPM runs on this machine on a cron, which "
      + "messages a chat only when something changed. Nothing is created until you allow a card in PPM that shows the "
      + "whole script, where and when it runs, and which chats it messages. It stays off until you choose.",
    tools: [SESSION_SCHEDULE_PROPOSE_SCRIPT_TOOL],
    since: "2026-11",
  },
  {
    // An editor setting, not AI tools: every open editor re-reads git's index every few seconds.
    id: "editor-gutter-changes-2026-11",
    title: "Changed lines in the editor's gutter",
    body: "The editor can mark lines that differ from what git has staged, as VS Code does: green added, blue changed, "
      + "red where lines were removed. Each open editor checks git every few seconds while it is on screen. "
      + "Settings → Appearance has the switch. It stays off until you choose.",
    tools: [],
    uiPref: "gutterChanges",
    since: "2026-11",
  },
];

export type FeatureIntroAnswer = "on" | "off";

/**
 * How a feature's question ended: answered in the tour, switched off after the last allowed
 * skip, or settled because its switches were already set in Settings → Tools.
 */
export type FeatureIntroResolution = "tour" | "skips" | "settings";

export interface FeatureIntroState {
  answer: FeatureIntroAnswer | null;
  skips: number;
  answeredAt?: string;
  via?: FeatureIntroResolution;
  /** Settings → Tools was opened after the feature was switched off by skipping. */
  seenInSettings?: boolean;
  /** When the last skip that counted was recorded; another within the window is not counted. */
  lastSkipAt?: string;
}

/** The install-wide record, config key `feature_intros`, keyed by `FeatureIntro.id`. */
export type FeatureIntroStates = Record<string, FeatureIntroState>;

/** "Later" this many times and the feature counts as off, marked NEW in Settings → Tools. */
export const MAX_FEATURE_INTRO_SKIPS = 3;

/**
 * At most one skip counts per feature in this window. Several tabs and devices open at once each
 * close the question, and counting every close would use up all three skips in one sitting.
 */
export const FEATURE_INTRO_SKIP_WINDOW_MS = 12 * 60 * 60 * 1000;

/** `/ws/global` event sent after any change, so every open device can refresh. */
export const FEATURE_INTROS_CHANGED_EVENT = "feature-intros:changed";

/** What changed: a device answered, put the question off, opened Settings, or a switch settled it. */
export type FeatureIntroChangeKind = "answer" | "skip" | "seen" | "settings";

/** The payload of {@link FEATURE_INTROS_CHANGED_EVENT}; `id` is absent when several may have changed. */
export interface FeatureIntrosChangedEvent {
  type: typeof FEATURE_INTROS_CHANGED_EVENT;
  change: FeatureIntroChangeKind;
  id?: string;
  answer?: FeatureIntroAnswer | null;
}

/** `GET /api/feature-intros`. */
export interface FeatureIntrosView {
  /** Not answered, not settled in Settings and skipped fewer than the allowed times. */
  pending: FeatureIntro[];
  /**
   * The install has at least one chat session. A project alone does not count: `ppm init` adds
   * every git repository it finds, and the basic tour's first step picks one.
   */
  isExistingUser: boolean;
  /** Switched off by skipping and not yet seen in Settings → Tools. */
  newInSettings: string[];
}

export const featureIntroById = (id: string): FeatureIntro | undefined => FEATURE_INTROS.find((intro) => intro.id === id);

/** The introduced feature `tool` belongs to, if any. */
export const featureIntroOfTool = (tool: string): FeatureIntro | undefined =>
  FEATURE_INTROS.find((intro) => (intro.tools as readonly string[]).includes(tool));

/** What the switches already set for `intro` say: null while none of them is set. */
export function answerFromSwitches(switches: PpmToolSwitches | undefined, intro: FeatureIntro): FeatureIntroAnswer | null {
  const set = intro.tools.map((tool) => switches?.[tool]).filter((value): value is boolean => typeof value === "boolean");
  if (set.length === 0) return null;
  return set.includes(true) ? "on" : "off";
}

/** What the saved `ui_prefs` say about `intro`'s setting: null while it is unset or `intro` has none. */
export function answerFromUiPrefs(prefs: Record<string, unknown> | undefined, intro: FeatureIntro): FeatureIntroAnswer | null {
  const value = intro.uiPref ? prefs?.[intro.uiPref] : undefined;
  return typeof value === "boolean" ? (value ? "on" : "off") : null;
}

/** Explicit switches for every tool of `intro`, as an answer writes them. */
export const switchesForAnswer = (intro: FeatureIntro, answer: FeatureIntroAnswer): PpmToolSwitches =>
  Object.fromEntries(intro.tools.map((tool) => [tool, answer === "on"])) as PpmToolSwitches;
