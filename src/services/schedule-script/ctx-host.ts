/**
 * PPM's side of a script's `ctx` (contract in the plan's ctx-api.md): answers the `call`s its
 * process makes. A call made wrongly — no prompt, an option that does not exist — throws, so
 * the script sees it at once; an AI that fails or runs out of time answers `ok: false`.
 */
import { isPlainObject } from "../../shared/schedule-definition.ts";
import type { Schedule } from "../../types/scheduler.ts";
import { projectService } from "../project.service.ts";
import { scheduleChat, type ChatCallOptions } from "./chat-bridge.ts";
import { scheduleAsk, type AskOptions } from "./ctx-ask.ts";
import { saveState } from "./ctx-state.ts";
import { collectFinishedTurns } from "./schedule-chat-db.ts";

const ASK_MAX_TIMEOUT_MS = 600_000;
const CHAT_MAX_TIMEOUT_MS = 2 * 60 * 60_000;
const TITLE_MAX = 200;
const NOTIFY_TITLE_MAX = 200;
const NOTIFY_BODY_MAX = 4000;
const SESSION_ID = /^[\w-]{1,128}$/;

export type CtxCall = (method: string, params: unknown) => Promise<unknown>;

export function ctxHost(schedule: Schedule): CtxCall {
  return async (method, params) => {
    const p = isPlainObject(params) ? params : {};
    switch (method) {
      case "save":
        saveState(schedule.id, p.state);
        return null;
      case "notify":
        await notify(schedule, p);
        return null;
      case "ai.ask": {
        const prompt = text(p.prompt, "ctx.ai.ask", "prompt");
        return scheduleAsk(schedule, prompt, askOptions(p.opts));
      }
      case "ai.chat": {
        const key = text(p.key, "ctx.ai.chat", "key", TITLE_MAX);
        const prompt = text(p.prompt, "ctx.ai.chat", "prompt");
        return scheduleChat(schedule, key, prompt, chatOptions(p.opts));
      }
      case "ai.finished":
        return collectFinishedTurns(schedule.id);
      default:
        throw new Error(`ctx has no ${method}`);
    }
  };
}

async function notify(schedule: Schedule, n: Record<string, unknown>): Promise<void> {
  const title = text(n.title, "ctx.notify", "title", NOTIFY_TITLE_MAX);
  if (typeof n.body !== "string") throw new Error("ctx.notify needs a body");
  if (n.sessionId !== undefined && (typeof n.sessionId !== "string" || !SESSION_ID.test(n.sessionId))) {
    throw new Error("ctx.notify: sessionId must be a chat's id");
  }
  let project = "";
  try { project = projectService.resolve(schedule.project_path).name; } catch { /* not a registered project */ }
  const { notificationService } = await import("../notification.service.ts");
  // Not awaited: the dispatcher may hold it for the notification delay.
  void notificationService.broadcast("schedule", {
    title, body: n.body.slice(0, NOTIFY_BODY_MAX), project, sessionId: (n.sessionId as string | undefined) ?? "",
  });
}

function askOptions(raw: unknown): AskOptions {
  const o = options(raw, "ctx.ai.ask", ["model", "system", "effort", "jsonSchema", "timeoutMs"]);
  if (o.model !== undefined) text(o.model, "ctx.ai.ask", "model");
  if (o.system !== undefined && typeof o.system !== "string") throw new Error("ctx.ai.ask: system must be text");
  if (o.effort !== undefined && !["low", "medium", "high"].includes(o.effort as string)) {
    throw new Error('ctx.ai.ask: effort must be "low", "medium" or "high"');
  }
  if (o.jsonSchema !== undefined && !isPlainObject(o.jsonSchema)) throw new Error("ctx.ai.ask: jsonSchema must be an object");
  timeout(o.timeoutMs, "ctx.ai.ask", ASK_MAX_TIMEOUT_MS);
  return o as AskOptions;
}

function chatOptions(raw: unknown): ChatCallOptions {
  const o = options(raw, "ctx.ai.chat", ["title", "projectPath", "sessionId", "wait", "timeoutMs"]);
  if (o.title !== undefined) o.title = text(o.title, "ctx.ai.chat", "title", TITLE_MAX);
  if (o.projectPath !== undefined) text(o.projectPath, "ctx.ai.chat", "projectPath");
  if (o.sessionId !== undefined && (typeof o.sessionId !== "string" || !SESSION_ID.test(o.sessionId))) {
    throw new Error("ctx.ai.chat: sessionId must be a chat's id");
  }
  if (o.wait !== undefined && typeof o.wait !== "boolean") throw new Error("ctx.ai.chat: wait must be true or false");
  timeout(o.timeoutMs, "ctx.ai.chat", CHAT_MAX_TIMEOUT_MS);
  return o as ChatCallOptions;
}

/** The options object, refusing a key the call does not have (a typo would otherwise be ignored). */
function options(raw: unknown, call: string, allowed: string[]): Record<string, unknown> {
  if (raw === undefined || raw === null) return {};
  if (!isPlainObject(raw)) throw new Error(`${call}: options must be an object`);
  const o = { ...raw };
  for (const key of Object.keys(o)) {
    if (o[key] === undefined) delete o[key];
    else if (!allowed.includes(key)) throw new Error(`${call} has no option "${key}" (it takes ${allowed.join(", ")})`);
  }
  return o;
}

function text(value: unknown, call: string, name: string, max?: number): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${call} needs a ${name}`);
  const trimmed = value.trim();
  if (max !== undefined && trimmed.length > max) throw new Error(`${call}: ${name} is longer than ${max} characters`);
  return name === "prompt" ? value : trimmed;
}

function timeout(value: unknown, call: string, max: number): void {
  if (value === undefined) return;
  if (!Number.isInteger(value) || (value as number) < 1000 || (value as number) > max) {
    throw new Error(`${call}: timeoutMs must be a whole number of milliseconds from 1000 to ${max}`);
  }
}
