/** Single-run execution for scheduled agents: session reuse, stream drain, bounded output. */
import { chatService } from "./chat.service.ts";
import { providerRegistry } from "../providers/registry.ts";
import { setScheduleSessionId } from "./scheduler-db.service.ts";
import type { Schedule, RunResult } from "../types/scheduler.ts";

const HEAD_CAP = 16 * 1024;
const TAIL_CAP = 16 * 1024;
const CONTEXT_ROTATION_THRESHOLD = 80; // % — same as ppmbot coordinator rotation

/** Head+tail bounded buffer — keeps first/last 16KB, drops the middle. */
class BoundedBuffer {
  private head = "";
  private tail = "";
  private droppedBytes = 0;

  append(chunk: string): void {
    if (this.head.length < HEAD_CAP) {
      const room = HEAD_CAP - this.head.length;
      this.head += chunk.slice(0, room);
      chunk = chunk.slice(room);
    }
    if (!chunk) return;
    this.tail += chunk;
    if (this.tail.length > TAIL_CAP) {
      this.droppedBytes += this.tail.length - TAIL_CAP;
      this.tail = this.tail.slice(-TAIL_CAP);
    }
  }

  toString(): string {
    if (!this.tail) return this.head;
    const marker = this.droppedBytes > 0 ? `\n... [truncated ${this.droppedBytes} bytes] ...\n` : "";
    return this.head + marker + this.tail;
  }
}

/** Resume the schedule's persistent session, or create one and persist its id. */
export async function ensureScheduleSession(schedule: Schedule): Promise<string> {
  if (schedule.session_id) {
    try {
      await chatService.resumeSession(schedule.provider_id, schedule.session_id);
      return schedule.session_id;
    } catch {
      // Stale/deleted session — fall through and create a fresh one
    }
  }
  const session = await chatService.createSession(schedule.provider_id, {
    projectPath: schedule.project_path,
    title: `Schedule: ${schedule.name}`,
  });
  setScheduleSessionId(schedule.id, session.id);
  return session.id;
}

/** Execute one schedule run: send prompt, drain stream until done, enforce wall-clock timeout. */
export async function runScheduleOnce(schedule: Schedule, sessionId: string): Promise<RunResult> {
  const buffer = new BoundedBuffer();
  const errors: string[] = [];
  let contextWindowPct: number | undefined;
  let costUsd: number | undefined;
  let resultSubtype: string | undefined;
  let timedOut = false;

  const provider = providerRegistry.get(schedule.provider_id);
  const killer = setTimeout(() => {
    timedOut = true;
    try { provider?.abortQuery?.(sessionId, "scheduler-timeout"); } catch { /* best-effort */ }
  }, schedule.timeout_ms);

  try {
    const stream = chatService.sendMessage(schedule.provider_id, sessionId, schedule.prompt, {
      permissionMode: schedule.permission_mode,
      ...(schedule.max_turns != null && { maxTurns: schedule.max_turns }),
    });
    for await (const event of stream) {
      if (event.type === "text") {
        buffer.append(event.content);
      } else if (event.type === "error") {
        errors.push(event.message);
      } else if (event.type === "done") {
        contextWindowPct = event.contextWindowPct;
        costUsd = event.costUsd;
        resultSubtype = event.resultSubtype;
        break; // streaming-input sessions stay open after done — must break, not drain to end
      }
    }
  } finally {
    clearTimeout(killer);
  }

  if (timedOut) errors.push(`Timed out after ${schedule.timeout_ms}ms (aborted)`);
  const failed = errors.length > 0 || (resultSubtype != null && resultSubtype !== "success");
  const result: RunResult = {
    status: failed ? "error" : "done",
    output: buffer.toString(),
    contextWindowPct,
    costUsd,
    error: failed ? (errors.join("\n") || `result: ${resultSubtype}`) : undefined,
  };

  // Rotate to a fresh session when context is nearly full — after the run, never
  // mid-stream, so one logical task is not split across sessions. Next run resumes new id.
  if (contextWindowPct != null && contextWindowPct > CONTEXT_ROTATION_THRESHOLD) {
    try {
      const fresh = await chatService.createSession(schedule.provider_id, {
        projectPath: schedule.project_path,
        title: `Schedule: ${schedule.name}`,
      });
      setScheduleSessionId(schedule.id, fresh.id);
      result.rotatedToSessionId = fresh.id;
      console.log(`[scheduler] rotated session for schedule ${schedule.id} (ctx ${contextWindowPct}%)`);
    } catch (e) {
      console.warn(`[scheduler] session rotation failed for ${schedule.id}: ${(e as Error).message}`);
    }
  }

  await notifyRunFinished(schedule, result);
  return result;
}

/** Telegram/push summary — broadcast() itself gates Telegram on no-active-browser. */
async function notifyRunFinished(schedule: Schedule, result: RunResult): Promise<void> {
  try {
    const { configService } = await import("./config.service.ts");
    const telegram = configService.get("telegram") as { bot_token?: string } | undefined;
    if (!telegram?.bot_token) return;
    const { notificationService } = await import("./notification.service.ts");
    const duration = result.costUsd != null ? ` · $${result.costUsd.toFixed(4)}` : "";
    const body = result.status === "error"
      ? `Failed: ${(result.error ?? "unknown error").slice(0, 300)}`
      : `${result.output.slice(0, 500) || "(no output)"}${duration}`;
    await notificationService.broadcast("done", {
      title: `Schedule: ${schedule.name} — ${result.status}`,
      body,
      project: schedule.project_path,
      sessionId: schedule.session_id ?? "",
    });
  } catch (e) {
    // Notify failures must not poison the run record
    console.warn(`[scheduler] notify failed for ${schedule.id}: ${(e as Error).message}`);
  }
}
