/**
 * What carries over from PPMBot, once: the system prompt the user wrote for it, appended to the
 * Assistant's own instructions under a heading that says where it came from.
 *
 * Only that. PPMBot's memories were written by the AI itself (and could have been talked into
 * anything), so they never become instructions — the highest-trust text a session reads.
 * Settings lists them for the user to copy by hand. PPMBot's other settings (provider, permission
 * mode, thinking) describe a coordinator that no longer exists and are simply dropped.
 *
 * Runs at every start and is a no-op after the first: the copied prompt is removed from the
 * `clawbot` row and a mark is set, so neither a restart nor an edit to the instructions brings it
 * back a second time.
 */
import { configService } from "../config.service.ts";
import { getConfigValue, setConfigValue } from "../db.service.ts";
import { getAssistantSettings } from "../assistant/assistant-settings.service.ts";
import { ASSISTANT_INSTRUCTIONS_MAX_CHARS } from "../../shared/assistant-settings.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("assistant-telegram");

/** Config row set once PPMBot's settings were carried over. */
export const PPMBOT_MIGRATED_KEY = "ppmbot_migrated";
export const PPMBOT_PROMPT_HEADING = "From PPMBot (copied once)";

export type PPMBotMigrationResult =
  | { ran: false }
  | { ran: true; copiedChars: number; truncated: boolean };

export function migratePPMBotSettings(): PPMBotMigrationResult {
  if (getConfigValue(PPMBOT_MIGRATED_KEY) !== null) return { ran: false };
  const stored = configService.get("clawbot") as (Record<string, unknown> & { system_prompt?: unknown }) | undefined;
  const prompt = typeof stored?.system_prompt === "string" ? stored.system_prompt.trim() : "";

  let copiedChars = 0;
  let truncated = false;
  if (prompt) {
    const settings = getAssistantSettings();
    const current = settings.instructions.trimEnd();
    const block = `${current ? "\n\n" : ""}## ${PPMBOT_PROMPT_HEADING}\n\n`;
    const room = ASSISTANT_INSTRUCTIONS_MAX_CHARS - current.length - block.length;
    if (room > 0) {
      const copied = prompt.slice(0, room);
      truncated = copied.length < prompt.length;
      copiedChars = copied.length;
      // Written straight to the row: the save path validates a whole pane, and these are the
      // stored settings plus text the user already wrote.
      configService.set("assistant", { ...settings, instructions: `${current}${block}${copied}` });
    } else {
      truncated = true;
    }
    if (truncated) log.warn(`PPMBot's system prompt did not fit the Assistant's instructions: ${prompt.length - copiedChars} characters left out`);
  }
  if (stored && "system_prompt" in stored) {
    const { system_prompt: _copied, ...rest } = stored;
    configService.set("clawbot", rest as never);
  }
  // A prompt that did not fit is kept whole in the mark, so the user's words are never lost.
  setConfigValue(PPMBOT_MIGRATED_KEY, JSON.stringify({ at: new Date().toISOString(), copiedChars, truncated, ...(truncated ? { prompt } : {}) }));
  if (copiedChars > 0) log.info(`Copied PPMBot's system prompt into the Assistant's instructions (${copiedChars} characters)`);
  return { ran: true, copiedChars, truncated };
}
