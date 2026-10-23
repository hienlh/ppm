import type { RpcClient } from "../types.ts";

/**
 * `api.ppm.chat` — chat sessions an extension drives with nobody watching. Each call is one
 * RPC the main thread answers in `src/services/extension-api/extension-chat-handlers.ts`.
 * A turn is started, never awaited: `send` answers as soon as the turn is queued, and
 * `waitForIdle` polls `state` until it ends.
 */

export interface PpmChatProject {
  name: string;
  path: string;
}

export interface PpmChatCreateSessionOptions {
  projectName: string;
  /** `claude`, `codex`, ... — chosen here, for the session's whole life. */
  providerId: string;
  title?: string;
  accountId?: string;
  /** Stored as the session's model, so a turn the user types later runs on it too. */
  model?: string;
}

export interface PpmChatSession {
  sessionId: string;
  providerId: string;
  projectName: string;
  title: string;
}

export interface PpmChatSendOptions {
  content: string;
  clientMessageId?: string;
  permissionMode?: string;
  priority?: "now" | "next" | "later";
  images?: Array<{ data: string; mediaType: string }>;
  imagePaths?: string[];
  model?: string;
  effort?: string;
  thinking?: boolean;
  /** Wall-clock budget in ms (1 s to 24 h); the turn is aborted past it. Default 30 min. */
  timeoutMs?: number;
  /** Send PPM's "Chat completed" push when the turn ends. Default false. */
  notifyOnDone?: boolean;
}

export interface PpmChatSendResult {
  sessionId: string;
  /** True when the message joined a live session as a follow-up. */
  queued: boolean;
}

export interface PpmChatState {
  running: boolean;
  phase: "initializing" | "connecting" | "thinking" | "streaming" | "idle";
  /** The first error the running (or last) turn reported. */
  lastError?: string;
}

export interface PpmChatWaitOptions {
  /** How often `state` is asked. Default 2 s. */
  pollMs?: number;
  /** Give up after this long; the turn keeps running. */
  timeoutMs?: number;
}

export interface PpmChat {
  listProjects(): Promise<PpmChatProject[]>;
  createSession(options: PpmChatCreateSessionOptions): Promise<PpmChatSession>;
  send(sessionId: string, options: PpmChatSendOptions): Promise<PpmChatSendResult>;
  cancel(sessionId: string): Promise<void>;
  state(sessionId: string): Promise<PpmChatState>;
  lastAssistantText(sessionId: string): Promise<string | null>;
  /** Opens the chat in the browser that ran this extension's command in the last 10 s. */
  openTab(sessionId: string): Promise<{ opened: boolean }>;
  /** Resolves with the final state once no turn runs; rejects when `timeoutMs` passes first. */
  waitForIdle(sessionId: string, options?: PpmChatWaitOptions): Promise<PpmChatState>;
}

const DEFAULT_POLL_MS = 2_000;

/**
 * `send` answers once the turn is queued, which can mean waiting out a consumer another
 * message is starting (the server gives a provider 120 s to answer its first message) and a
 * subprocess restart for a model change (10 s) — well past the 10 s every other RPC gets.
 */
export const CHAT_SEND_RPC_TIMEOUT_MS = 150_000;

export function createPpmChat(rpc: RpcClient, extensionId: string): PpmChat {
  const state = (sessionId: string) => rpc.request<PpmChatState>("chat:state", { sessionId });
  return {
    listProjects: () => rpc.request<PpmChatProject[]>("chat:listProjects", {}),
    // The extension's id travels with the calls that create and drive sessions: a session
    // may only be sent to or stopped by the extension that created it.
    createSession: (options) => rpc.request<PpmChatSession>("chat:createSession", { ...options, extensionId }),
    send: (sessionId, options) => rpc.requestWithTimeout<PpmChatSendResult>("chat:send", CHAT_SEND_RPC_TIMEOUT_MS, { ...options, sessionId, extensionId }),
    cancel: async (sessionId) => { await rpc.request("chat:cancel", { sessionId, extensionId }); },
    state,
    lastAssistantText: (sessionId) => rpc.request<string | null>("chat:lastAssistantText", { sessionId }),
    openTab: (sessionId) => rpc.request<{ opened: boolean }>("chat:openTab", { sessionId, extensionId }),
    async waitForIdle(sessionId, options = {}) {
      const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
      const deadline = options.timeoutMs !== undefined ? Date.now() + options.timeoutMs : undefined;
      for (;;) {
        const current = await state(sessionId);
        if (!current.running) return current;
        if (deadline !== undefined && Date.now() >= deadline) throw new Error(`waitForIdle: session ${sessionId} still running after ${options.timeoutMs}ms`);
        await new Promise<void>((resolve) => setTimeout(resolve, pollMs));
      }
    },
  };
}
