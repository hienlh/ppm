/**
 * The memory host's process-wide wiring: one embedding queue on the embedder the settings name,
 * kicked after every sync and every tool write, and one listener the host forwards to the server
 * (which broadcasts on `/ws/global`). It reads no config: the server sends the settings
 * (`setMemoryRuntimeSettings`) with every change, through the host's `configure`.
 */
import { createEmbedQueue, type EmbedQueueStatus } from "./embedding/embed-queue.ts";
import type { Embedder } from "./embedding/embedder.ts";
import { GLOBAL_MEMORY_KEY, getMemoryIndex } from "./memory-index.ts";
import { projectMemoryKey } from "./memory-paths.ts";
import { currentEmbedder, type MemoryAi } from "./memory-settings.ts";
import { memoryDir } from "./memory-store.ts";
import { memorySync, setMemoryChangeListener, type MemoryChange } from "./memory-sync.ts";
import type { MemoryScope } from "./memory-types.ts";

export type MemoryRuntimeEvent =
  | { kind: "changed"; change: MemoryChange }
  | { kind: "embedding"; status: EmbedQueueStatus };

let listener: ((event: MemoryRuntimeEvent) => void) | null = null;
let settings: MemoryAi = {};

/** Where memory events go; the host sends them to the server. */
export function setMemoryRuntimeListener(fn: ((event: MemoryRuntimeEvent) => void) | null): void {
  listener = fn;
}

/** The AI settings the embedder and the switches are read from, as the server last sent them. */
export function setMemoryRuntimeSettings(ai: MemoryAi): void {
  settings = ai;
}

/** The embedder of the settings as they are now, null when the source is Off. */
export const memoryEmbedder = (): Embedder | null => currentEmbedder(settings);

export const memoryEmbedQueue = createEmbedQueue({
  embedder: memoryEmbedder,
  onChange: (status) => listener?.({ kind: "embedding", status }),
});

memorySync.afterSync(({ keys }) => memoryEmbedQueue.kick(keys.find((key) => key !== GLOBAL_MEMORY_KEY)));
setMemoryChangeListener((change) => listener?.({ kind: "changed", change }));

/**
 * After a tool wrote or archived a memory: index the folder now, so the next search sees it,
 * then embed it in the background and tell the browser.
 */
export async function memoryWritten(scope: MemoryScope, projectPath: string | null): Promise<void> {
  const key = scope === "global" || !projectPath ? GLOBAL_MEMORY_KEY : projectMemoryKey(projectPath);
  await getMemoryIndex().reconcile(memoryDir(scope, projectPath ?? undefined), scope, key);
  void memoryEmbedQueue.kick(key === GLOBAL_MEMORY_KEY ? undefined : key);
  listener?.({ kind: "changed", change: { projectPath: projectPath ?? "", scopes: [scope] } });
}
