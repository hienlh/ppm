/**
 * The two checks a kill and a signal make about the CALLER's intent, after the live re-query and
 * the identity check and before the guard, so the two chains cannot drift apart:
 *
 * - `expectName`: the name the caller believes the pid has. Checked for every caller that sends
 *   it, against the FRESH name: a mismatch ends nothing (409). This is what lets an approved
 *   `ppm system kill 12345 --expect-name node` line say what it ends.
 * - A request from an AI chat (`X-PPM-AI-Chat: 1`) may not end or signal a chat's provider
 *   process — the chat's own, or another's — because that cuts a turn off with no card. Advisory:
 *   the header is the chat's to send, and the Task Manager keeps the ability to end a stuck one.
 */
import { collectDescendants } from "./kill-guard.ts";
import type { GuardMaps, LiveProcessIdentity } from "./kill-identity-resolver.ts";
import { chatProviderPids, normalizeProcessName } from "./chat-provider-pids.ts";

/** Who asked. `aiChat` is the request's own claim, never proof. */
export interface KillCaller {
  aiChat?: boolean;
}

export interface CallerRefusal {
  status: 403 | 409;
  message: string;
  /** For the audit line. */
  reason: string;
}

/** `expectName` from a request body: absent, or a non-empty name of at most 256 characters. */
export function parseExpectName(value: unknown): { ok: true; name?: string } | { ok: false } {
  if (value === undefined) return { ok: true };
  if (typeof value !== "string") return { ok: false };
  const name = value.trim();
  if (!name || name.length > 256) return { ok: false };
  return { ok: true, name };
}

export function callerRefusal(
  live: LiveProcessIdentity,
  expectName: string | undefined,
  tree: boolean,
  maps: GuardMaps,
  caller: KillCaller,
  providerPids: (maps: GuardMaps) => Set<number> = chatProviderPids,
): CallerRefusal | null {
  if (expectName !== undefined && normalizeProcessName(expectName) !== normalizeProcessName(live.name)) {
    return {
      status: 409,
      message: `PID ${live.pid} is "${live.name}", not "${expectName}" — nothing was done`,
      reason: `expected name ${JSON.stringify(expectName)}`,
    };
  }
  if (!caller.aiChat) return null;
  const providers = providerPids(maps);
  if (providers.size === 0) return null;
  const hit = providers.has(live.pid)
    ? live.pid
    : tree ? [...collectDescendants(live.pid, maps)].find((pid) => providers.has(pid)) : undefined;
  if (hit === undefined) return null;
  const what = hit === live.pid ? `${live.name} (PID ${live.pid}) is` : `this process tree holds PID ${hit}, which is`;
  return {
    status: 403,
    message: `${what} a chat's AI provider; ending it would cut that chat's turn off — use chat_stop to stop a chat.`,
    reason: `chat provider pid ${hit}, AI caller`,
  };
}
