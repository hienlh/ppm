/**
 * The manager-chat half of the Assistant e2e fixture (`assistant-server.ts` with
 * PPM_ASSISTANT_MANAGER_LOOP=1), for `tests/e2e/assistant-manager-loop-e2e.mjs`:
 *
 * - a clock the e2e moves forward (`POST /__assistant-test/clock {advanceMs}`): every Assistant
 *   schedule (send budgets, the wake queue's hour, quiet hours, the digest, card times) reads it,
 *   and a timer armed on it fires as soon as the jump makes it due;
 * - the Claude provider's `completeOnce`, which the manager-rules check asks: every added line is a
 *   restriction unless it contains RELAX (the e2e never sends a real model anything);
 * - `POST /__assistant-test/say {project, sessionId, text, permissionMode?}`: a message typed into a
 *   project chat, sent over the real chat socket as a browser would.
 *
 * Imported only after `assistant-server.ts` has checked that PPM_HOME and HOME are scratch
 * directories.
 */
import type { AssistantClock } from "../../../src/services/assistant-wake/assistant-clock";

const json = (body: unknown, status = 200) => Response.json(body, { status });

interface JumpTimer { at: number; fn: () => void; live: boolean }

/**
 * Real time plus an offset that only grows: a timer is due once either catches up with it. A
 * restarted fixture starts at the offset the previous run reached (PPM_ASSISTANT_CLOCK_OFFSET_MS),
 * so quiet hours and the hourly caps read the same clock on both sides of the restart.
 */
function jumpClock(initialOffset = 0): AssistantClock & { advance(ms: number): number; offset(): number } {
  let offset = initialOffset;
  const timers: JumpTimer[] = [];
  const now = () => Date.now() + offset;
  const fire = (t: JumpTimer) => {
    if (!t.live) return;
    t.live = false;
    try { t.fn(); } catch (e) { console.error(`[e2e clock] a timer threw: ${(e as Error).message}`); }
  };
  const fireDue = () => {
    // A timer a fired one arms may be due at once: keep going until none is.
    for (let round = 0; round < 50; round++) {
      const due = timers.filter((t) => t.live && t.at <= now()).sort((a, b) => a.at - b.at);
      if (due.length === 0) break;
      for (const t of due) fire(t);
    }
    for (let i = timers.length - 1; i >= 0; i--) if (!timers[i]!.live) timers.splice(i, 1);
  };
  return {
    now,
    setTimer(fn, ms) {
      const t: JumpTimer = { at: now() + Math.max(0, ms), fn, live: true };
      timers.push(t);
      const real = setTimeout(() => fire(t), Math.min(Math.max(0, ms), 2 ** 31 - 1));
      (real as { unref?: () => void }).unref?.();
      return () => { t.live = false; clearTimeout(real); };
    },
    advance(ms) {
      offset += Math.max(0, ms);
      fireDue();
      return now();
    },
    offset: () => offset,
  };
}

/**
 * The added lines the rules check was asked about. The prompt lists them as a JSON array after
 * "numbered from 1):", each a line with the heading it sits under (`{ line, under }`); a plain
 * string is read too, as the prompt once had it.
 */
function addedLines(prompt: string): string[] {
  const match = prompt.match(/^Added lines[^\n]*\(JSON array, numbered from 1\): (\[.*\])$/m);
  if (!match) return [];
  return (JSON.parse(match[1]!) as Array<string | { line: string }>).map((a) => (typeof a === "string" ? a : a.line));
}

/** Verdicts for the rules check: a restriction, unless the line asks to be read as relaxing. */
function rulesVerdicts(prompt: string): string {
  const added = addedLines(prompt);
  return JSON.stringify({
    verdicts: added.map((line, i) => ({ line: i + 1, verdict: line.includes("RELAX") ? "relaxes_or_unclear" : "restriction" })),
  });
}

export interface ManagerLoopFixture {
  /** Given to the scripted Claude provider. */
  completeOnce(input: { prompt: string }): Promise<{ text: string }>;
  /** Handles `/__assistant-test/<route>` for the loop e2e; null for a route it does not own. */
  route(req: Request, route: string): Promise<Response | null>;
}

export async function setupManagerLoop(opts: { port: number }): Promise<ManagerLoopFixture> {
  // No "PPM has new features" panel over what the e2e clicks; the session tools stay on.
  const { answerFeatureIntrosAtStartup } = await import("./answer-feature-intros");
  await answerFeatureIntrosAtStartup("on");
  const { setAssistantClock } = await import("../../../src/services/assistant-wake/assistant-clock");
  const startOffset = Number(process.env.PPM_ASSISTANT_CLOCK_OFFSET_MS ?? 0);
  if (!Number.isFinite(startOffset) || startOffset < 0) throw new Error("PPM_ASSISTANT_CLOCK_OFFSET_MS must be a number >= 0");
  const clock = jumpClock(startOffset);
  setAssistantClock(clock);
  const rulesChecks: string[][] = [];

  /** A message typed into a project chat, over the chat socket; resolves once the socket closed. */
  async function say(b: { project: string; sessionId: string; text: string; permissionMode?: string }): Promise<void> {
    const url = `ws://127.0.0.1:${opts.port}/ws/project/${encodeURIComponent(b.project)}/chat/${b.sessionId}?providerId=claude`;
    const socket = new WebSocket(url);
    await new Promise<void>((done, fail) => {
      socket.onopen = () => done();
      socket.onerror = () => fail(new Error(`could not open ${url}`));
    });
    socket.send(JSON.stringify({
      type: "message", content: b.text, clientMessageId: crypto.randomUUID(),
      ...(b.permissionMode ? { permissionMode: b.permissionMode } : {}),
    }));
    // The server takes the message off the socket at once; the turn goes on without it.
    await Bun.sleep(800);
    socket.close();
  }

  return {
    async completeOnce({ prompt }) {
      rulesChecks.push(addedLines(prompt));
      return { text: rulesVerdicts(prompt) };
    },
    async route(req, route) {
      if (route === "clock") {
        if (req.method === "POST") {
          const { advanceMs } = await req.json() as { advanceMs?: unknown };
          if (typeof advanceMs !== "number" || !Number.isFinite(advanceMs) || advanceMs < 0) return json({ error: "advanceMs must be a number >= 0" }, 400);
          clock.advance(advanceMs);
          // The wake queue looks for held news on its own 30 s tick; a jump should not wait for it.
          const { assistantWakeQueue } = await import("../../../src/services/assistant-wake/assistant-wake-queue");
          assistantWakeQueue.tick();
        }
        return json({ now: clock.now(), offset: clock.offset() });
      }
      if (route === "rules-checks") return json(rulesChecks);
      if (route === "say" && req.method === "POST") {
        const b = await req.json() as { project?: unknown; sessionId?: unknown; text?: unknown; permissionMode?: unknown };
        if (typeof b.project !== "string" || typeof b.sessionId !== "string" || typeof b.text !== "string") {
          return json({ error: "project, sessionId and text are required" }, 400);
        }
        await say({ project: b.project, sessionId: b.sessionId, text: b.text, ...(typeof b.permissionMode === "string" ? { permissionMode: b.permissionMode } : {}) });
        return json({ ok: true });
      }
      return null;
    },
  };
}
