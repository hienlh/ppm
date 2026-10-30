// Pure helpers for the unified model + thinking picker. Kept DOM-free so the
// label↔value mapping (the crash-prone "Extra"→"xhigh" contract) is unit-testable
// without a browser harness.
//
// SDK effort enum = low | medium | high | xhigh | max. The app UI shows "Extra"
// for the SDK value "xhigh"; the literal "extra" would crash the CLI subprocess,
// so it must NEVER appear as a value here.

import {
  effortEnvMeaning, effortInEffect, effortSettingPlace, isEffortLevel,
  type EffortInEffect, type EffortLevel, type EffortStatus,
} from "../../../shared/effort-status";
import { modelDisplayName } from "@/lib/model-display-name";

export interface EffortOption {
  label: string;
  value: "low" | "medium" | "high" | "xhigh" | "max";
  default?: boolean;
}

export const EFFORT_OPTIONS: EffortOption[] = [
  { label: "Low", value: "low" },
  { label: "Medium", value: "medium" },
  { label: "High", value: "high", default: true },
  { label: "Extra", value: "xhigh" },
  { label: "Max", value: "max" },
];

/** UI label for an effort value; falls back to the raw value when unknown. */
export function effortLabel(value: string | null | undefined): string {
  if (!value) return "";
  return EFFORT_OPTIONS.find((o) => o.value === value)?.label ?? value;
}

/** Chip text: model display, plus " · <Effort>" when an effort is set. */
export function chipLabel(modelDisplay: string, effortValue: string | null | undefined): string {
  const eff = effortLabel(effortValue);
  return eff ? `${modelDisplay} · ${eff}` : modelDisplay;
}

export const DEFAULT_EFFORT = EFFORT_OPTIONS.find((o) => o.default)!.value;

/** The picked effort beside the one the turns run at, and what overrides the pick if anything does. */
export function shownEffort(
  effort: string | null | undefined,
  status: EffortStatus | null | undefined,
): EffortInEffect & { pick: EffortLevel } {
  const pick = isEffortLevel(effort) ? effort : DEFAULT_EFFORT;
  return { pick, ...effortInEffect(pick, status) };
}

/** Notice text; the names a user would type or search for (a variable, a file) are marked as code. */
export type NoticePart = string | { code: string };

export interface EffortNotice {
  title: string;
  detail: NoticePart[];
}

export function noticeText(parts: NoticePart[]): string {
  return parts.map((part) => (typeof part === "string" ? part : part.code)).join("");
}

const USE_PPM_PICK = "Remove it there to use the effort picked in PPM.";

/**
 * Why the effort the turns run at is not the one picked, naming the setting and where it is, so
 * the user can change it. Null when the pick is what runs.
 */
export function effortNotice(
  shown: EffortInEffect & { pick: EffortLevel },
  status: EffortStatus | null | undefined,
  modelDisplay: string,
): EffortNotice | null {
  if (!shown.reason || !status) return null;
  const observedModel = status.observed?.model;
  const model = observedModel ? modelDisplayName(observedModel.replace(/\[[^\]]*\]$/, "")) : modelDisplay;
  const level = shown.level ? effortLabel(shown.level) : null;

  const meaning = effortEnvMeaning(status.env?.value);
  if (shown.reason === "env" && status.env && meaning) {
    const setting: NoticePart[] = [{ code: `CLAUDE_CODE_EFFORT_LEVEL=${status.env.value}` }, " in ", { code: effortSettingPlace(status.env) }];
    if (meaning.kind === "auto") {
      // With a cap in place the CLI sends the model's default, clamped, rather than nothing, and
      // until it answers that default is not known here, so the sentence names only the cap.
      const what = status.cap
        ? `Claude Code sends ${model}'s default effort, capped at ${effortLabel(status.cap.value)}.`
        : level
          ? `Claude Code sends ${model}'s default, ${level}.`
          : `no effort is sent, so ${model}'s default applies.`;
      return { title: "Effort is left to the model", detail: [...setting, ` overrides the effort picked here: ${what} `, USE_PPM_PICK] };
    }
    if (meaning.kind === "budget") {
      // Under a cap the CLI reads the number as High, clamped, instead of as a thinking budget.
      if (level) {
        return { title: `Effort is set to ${level} outside PPM`, detail: [...setting, ` overrides the effort picked here; with a maxEffortLevel set, Claude Code runs it as ${level}. `, USE_PPM_PICK] };
      }
      return { title: "A thinking budget replaces the effort", detail: [...setting, " sets a thinking budget instead of an effort level, so the effort picked here is not sent. ", USE_PPM_PICK] };
    }
    const runs = shown.level === meaning.level ? "" : level ? ` ${model} runs it as ${level}.` : ` ${model} takes no effort level, so none is sent.`;
    return { title: `Effort is set to ${effortLabel(meaning.level)} outside PPM`, detail: [...setting, ` overrides the effort picked here.${runs} `, USE_PPM_PICK] };
  }
  if (shown.reason === "cap" && status.cap) {
    const runs = shown.level === status.cap.value || !level ? "" : ` ${model} runs it as ${level}.`;
    return {
      title: `Effort is capped at ${effortLabel(status.cap.value)}`,
      detail: [{ code: `maxEffortLevel: "${status.cap.value}"` }, " in ", { code: effortSettingPlace(status.cap) }, ` lowers any effort picked above it.${runs}`],
    };
  }
  if (!level) return { title: `${model} takes no effort level`, detail: [`Claude Code sends no effort with ${model}, so the effort picked here has no effect.`] };
  return { title: `Runs at ${level}`, detail: [`${effortLabel(shown.pick)} isn't available for ${model}, so Claude Code runs it at ${level}.`] };
}
