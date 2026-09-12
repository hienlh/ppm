/**
 * Running one agent turn for the provider-scoped proxy, independent of which
 * API format the caller speaks.
 *
 * `/proxy/<provider>/v1/messages` (Anthropic) and
 * `/proxy/<provider>/v1/chat/completions` (OpenAI) are two wire formats over
 * this same machinery, so session lifetime, sandboxing and timeouts are decided
 * here once rather than twice.
 *
 * Sessions are ephemeral: one per request, deleted afterwards. An API call must
 * not leave a conversation behind in the sidebar.
 */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { providerRegistry } from "../providers/registry.ts";
import { getPpmDir } from "./ppm-dir.ts";
import type { AIProvider, ChatEvent } from "../types/chat.ts";
import { takePooledSession, releasePooledSession } from "./proxy-agent-pool.ts";

/**
 * Read-only, no prompts. An agent reachable with the proxy key must not be able
 * to write or run anything on the host, so the caller cannot raise this.
 */
const PROXY_PERMISSION_MODE = "plan";

/**
 * Two deadlines, because the two failures look nothing alike. A provider whose
 * backend rejects the turn can report the failure on its subprocess stderr and
 * emit no event at all, so the request would otherwise sit at full idle length
 * waiting for a stream that will never start. Once text is flowing, a long gap
 * is just the agent working and must not be cut short.
 */
const FIRST_EVENT_TIMEOUT_MS = 90_000;
const IDLE_TIMEOUT_MS = 300_000;

/** Providers that exist in the registry but must never be exposed over HTTP. */
const NOT_PROXYABLE = new Set(["mock"]);

/** Resolve a provider the proxy is allowed to expose, or null. */
export function resolveProvider(providerId: string): AIProvider | null {
  if (NOT_PROXYABLE.has(providerId)) return null;
  return providerRegistry.get(providerId) ?? null;
}

/** Proxyable provider ids, for an error that tells the caller what does work. */
export function proxyableProviderIds(): string[] {
  return providerRegistry.listAll().map((p) => p.id).filter((id) => !NOT_PROXYABLE.has(id));
}

/**
 * Empty scratch workspace. Agents need a cwd; giving every proxy turn the same
 * empty directory keeps them away from real projects on this host.
 */
function proxyWorkspace(): string {
  const dir = resolve(getPpmDir(), "proxy-agent-workspace");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Stop iterating if the agent goes quiet — a hung turn must not pin the request. */
async function* withTimeout(events: AsyncIterable<ChatEvent>): AsyncIterable<ChatEvent> {
  const iterator = events[Symbol.asyncIterator]();
  let started = false;
  for (;;) {
    const ms = started ? IDLE_TIMEOUT_MS : FIRST_EVENT_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((r) => { timer = setTimeout(() => r("timeout"), ms); });
    try {
      const next = await Promise.race([iterator.next(), timeout]);
      if (next === "timeout") {
        await iterator.return?.(undefined);
        throw new Error(started
          ? `Agent stalled for ${Math.round(ms / 1000)}s mid-answer`
          : `Agent produced no output within ${Math.round(ms / 1000)}s — check the provider's account is still signed in`);
      }
      if (next.done) return;
      started = true;
      yield next.value;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Token counts a provider reported on `done`, in the shape both formats need. */
export interface TurnUsageCounts {
  inputTokens: number;
  outputTokens: number;
}

export function usageOf(ev: Extract<ChatEvent, { type: "done" }>): TurnUsageCounts | undefined {
  const u = ev.usage;
  if (!u) return undefined;
  // The whole replayed prefix counts as input, cached portions included.
  return {
    inputTokens: u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens,
    outputTokens: u.outputTokens,
  };
}

export interface TurnRequest {
  /** Conversation flattened to a single prompt. */
  prompt: string;
  /** Leading instructions, if the caller sent any. */
  systemPrompt?: string;
  /** Model name passed straight to the provider. */
  model?: string;
  /**
   * Local files holding the request's images. Codex takes an image as a path
   * and has no base64 form, so an inline attachment reaches the agent only
   * after the caller has written it to disk.
   */
  imagePaths?: string[];
}

export interface TurnRun {
  events: AsyncIterable<ChatEvent>;
  /** Deletes the ephemeral session. Callers must run it on every path. */
  cleanup: () => Promise<void>;
}

/**
 * Open an ephemeral session and start one turn. Throws if the provider is not
 * proxyable or the request carries nothing to answer.
 */
export async function startAgentTurn(providerId: string, req: TurnRequest): Promise<TurnRun> {
  const provider = resolveProvider(providerId);
  if (!provider) throw new Error(`Unknown provider "${providerId}"`);
  if (!req.prompt.trim()) throw new Error("messages must contain at least one non-system message");

  // No provider-level system-prompt field survives the flattening, so the
  // instructions lead the turn instead.
  const message = req.systemPrompt ? `${req.systemPrompt}\n\n${req.prompt}` : req.prompt;

  // The turn's options must match what the session was warmed with — a provider
  // may bake sandbox and model into the connection it opened.
  const opts = {
    permissionMode: PROXY_PERMISSION_MODE,
    ...(req.model ? { model: req.model } : {}),
    ...(req.imagePaths?.length ? { imagePaths: req.imagePaths } : {}),
  };
  const sessionId = await takePooledSession(providerId, {
    provider, opts,
    projectPath: proxyWorkspace(),
    title: `[API] ${providerId}`,
  });

  const events = provider.sendMessage(sessionId, message, opts);

  return {
    events: withTimeout(events),
    cleanup: () => releasePooledSession(provider, sessionId),
  };
}

/** `<provider>/v1/models` in OpenAI's list shape, so clients can discover models. */
export async function listProviderModels(providerId: string): Promise<Response> {
  const provider = resolveProvider(providerId);
  if (!provider) {
    return new Response(
      JSON.stringify({ error: { message: `Unknown provider "${providerId}"`, type: "server_error", code: "404" } }),
      { status: 404, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } },
    );
  }
  const models = provider.listModels ? await provider.listModels() : [];
  return new Response(JSON.stringify({
    object: "list",
    data: models.map((m) => ({ id: m.value, object: "model", owned_by: providerId })),
  }), { status: 200, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
}
