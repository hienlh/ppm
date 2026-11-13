/**
 * Which live processes are a chat's AI provider: the Claude CLI and `codex app-server`.
 *
 * Ending one ends that chat's turn mid-step, with no `chat_stop` card and nothing in the chat to
 * say why — so a kill or signal that an AI chat asks for is refused on these pids (the Task
 * Manager keeps the ability to end a stuck one). Advisory, like every check keyed on the AI mark.
 *
 * Each provider registers the pid it spawns, and drops it when that process exits:
 * - the Claude CLI where PPM spawns it itself (`claude-cli-process-group.ts`, Linux and macOS);
 * - every `codex app-server` (`codex-jsonrpc-client.ts`), whose launcher may start the real binary
 *   as a child — so a registered pid's descendants named `codex`/`claude` count too.
 * On Windows the SDK spawns the Claude CLI itself and its pid is never handed to PPM; there a
 * direct child of the server that is recognisably a provider (by name or by its command line)
 * counts instead. A provider found by neither rule is simply not protected.
 */
import { collectDescendants } from "./kill-guard.ts";
import type { GuardMaps } from "./kill-identity-resolver.ts";
import { stripExecutableExtension } from "./process-collector-types.ts";

const registered = new Map<number, string>();

/** Records `pid` as a chat provider's process; the returned function forgets it again. */
export function registerChatProviderPid(pid: number | undefined, label: string): () => void {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return () => {};
  registered.set(pid, label);
  return () => {
    if (registered.get(pid) === label) registered.delete(pid);
  };
}

/** The pids registered right now, for tests and the log. */
export function registeredChatProviderPids(): ReadonlyMap<number, string> {
  return registered;
}

/** For tests: forget every registration. */
export function _clearChatProviderPids(): void {
  registered.clear();
}

/** A process name as the guard compares it: case and a Windows extension ignored. */
export function normalizeProcessName(name: string): string {
  return stripExecutableExtension(name.trim()).toLowerCase();
}

const PROVIDER_NAMES = new Set(["claude", "codex"]);
/** The Claude CLI the SDK runs under node, or the codex launcher, as a command line names them. */
const PROVIDER_COMMAND = /claude-agent-sdk[\\/]+cli\.js|@anthropic-ai[\\/]+claude-code|@openai[\\/]+codex/i;

/** Every live pid in `maps` that is a chat provider's process. */
export function chatProviderPids(maps: Pick<GuardMaps, "byPid" | "ppidOf" | "startedAtOf">, serverPid = process.pid): Set<number> {
  const out = new Set<number>();
  const nameOf = (pid: number) => normalizeProcessName(maps.byPid.get(pid)?.name ?? "");
  for (const pid of registered.keys()) {
    if (!maps.byPid.has(pid)) continue;
    out.add(pid);
    for (const child of collectDescendants(pid, maps)) {
      if (PROVIDER_NAMES.has(nameOf(child))) out.add(child);
    }
  }
  for (const [pid, row] of maps.byPid) {
    if (row.ppid !== serverPid) continue;
    if (PROVIDER_NAMES.has(nameOf(pid)) || PROVIDER_COMMAND.test(row.command ?? "")) out.add(pid);
  }
  return out;
}
