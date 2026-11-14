/**
 * Whether a Claude chat is spawned without Claude Code's own cron tools. They are hidden only
 * where PPM's schedule tool takes their place — the chat has the session tools' server and the
 * user has the tool on — and `ai.hide_builtin_cron` (on unless set false) asks for it. A chat
 * without PPM's tool keeps CronCreate rather than being left with no way to schedule at all.
 *
 * Hidden through `disallowedTools`, not `CLAUDE_CODE_DISABLE_CRON`: that switch also gates the
 * scheduler `/loop` and `ScheduleWakeup` run on, which have nothing to do with durable schedules.
 *
 * A warm spare and the turn that takes it over both decide it here, from the same inputs, so the
 * two spawn the same CLI (`spawnFingerprint` compares the options).
 */
import { ppmToolOn } from "../shared/ppm-tools.ts";
import { CLAUDE_BUILTIN_CRON_TOOLS, SESSION_SCHEDULE_CREATE_TOOL } from "../shared/session-schedule-tools.ts";

type AiSettings = Parameters<typeof ppmToolOn>[0] & { hide_builtin_cron?: boolean };

/** The built-in tools to pass as `disallowedTools`: all three cron tools, or none. */
export function hiddenBuiltinCronTools(ai: AiSettings, scheduleToolServerAttached: boolean): string[] {
  if (!scheduleToolServerAttached || ai.hide_builtin_cron === false) return [];
  return ppmToolOn(ai, SESSION_SCHEDULE_CREATE_TOOL) ? [...CLAUDE_BUILTIN_CRON_TOOLS] : [];
}
