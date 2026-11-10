/**
 * The queue of messages a person sent while a turn was running (Claude Code's queue), held per
 * session on the server so every device shows the same stack (`src/shared/chat-queue.ts`).
 *
 * Two kinds of entry. A provider that queues a mid-turn push itself (Claude: it reads it at the
 * turn's next step, or after the turn) gets the message at once, tagged with the entry's id, and
 * reports it back as `queue_lifecycle`; the entry leaves the list when the provider starts reading
 * it. For every other provider PPM holds the entry and sends what it holds as one message when the
 * turn ends. Either way a message enters the conversation (`user_message` to every device, the
 * sender's included) only when the AI starts on it, which is when Claude Code stops showing it as
 * queued.
 */
import type { AIProvider } from "../../types/chat.ts";
import { joinQueuedContent, type QueuedMessage, type QueueLifecycleState } from "../../shared/chat-queue.ts";
import { decodeMessageBlocks, encodeMessageBlocks } from "../../shared/chat-message-blocks.ts";
import { validateTurnRefs } from "../../shared/chat-turn-ref.ts";

export interface QueuedEntry extends QueuedMessage {
  images?: Array<{ data: string; mediaType: string }>;
  imagePaths?: string[];
  /** Pushed into the provider's own queue; otherwise PPM holds it until the turn ends. */
  native: boolean;
}

export interface QueueHolder {
  queue?: QueuedEntry[];
}

export interface QueueDeps {
  sessionId: string;
  provider: AIProvider | undefined;
  broadcast: (event: object) => void;
  /** Push into the live stream, tagged with `queueId` for a native entry. False: no stream took it. */
  push: (content: string, opts: { queueId?: string; images?: QueuedEntry["images"]; imagePaths?: string[]; clientMessageId?: string }) => Promise<boolean>;
}

export interface EnqueueInput {
  content: string;
  images?: QueuedEntry["images"];
  imagePaths?: string[];
  clientMessageId?: string;
}

export function queueState(holder: QueueHolder): QueuedMessage[] {
  return (holder.queue ?? []).map(({ id, content, imageCount, clientMessageId, queuedAt }) => ({
    id, content, imageCount, queuedAt, ...(clientMessageId ? { clientMessageId } : {}),
  }));
}

function announce(holder: QueueHolder, deps: Pick<QueueDeps, "broadcast">): void {
  deps.broadcast({ type: "queue_state", queue: queueState(holder) });
}

function remove(holder: QueueHolder, id: string): QueuedEntry | undefined {
  const at = holder.queue?.findIndex((e) => e.id === id) ?? -1;
  if (at < 0) return undefined;
  return holder.queue!.splice(at, 1)[0];
}

/**
 * Queues a message sent mid-turn. `stream_closed` when the provider queues natively but had no
 * stream left to take the push: the caller starts a turn with it instead.
 */
export async function enqueueMessage(holder: QueueHolder, input: EnqueueInput, deps: QueueDeps): Promise<QueuedEntry | "stream_closed"> {
  const native = typeof deps.provider?.cancelQueuedMessage === "function";
  const entry: QueuedEntry = {
    id: crypto.randomUUID(),
    content: input.content,
    imageCount: input.images?.length ?? input.imagePaths?.length ?? 0,
    ...(input.clientMessageId ? { clientMessageId: input.clientMessageId } : {}),
    queuedAt: new Date().toISOString(),
    ...(input.images?.length ? { images: input.images } : {}),
    ...(input.imagePaths?.length ? { imagePaths: input.imagePaths } : {}),
    native,
  };
  // Listed before the push: the provider may report `started` before the push returns.
  (holder.queue ??= []).push(entry);
  if (native) {
    const pushed = await deps.push(entry.content, {
      queueId: entry.id, images: entry.images, imagePaths: entry.imagePaths, clientMessageId: entry.clientMessageId,
    });
    if (!pushed) {
      remove(holder, entry.id);
      return "stream_closed";
    }
  }
  // Already read (a `started` that beat the push back) leaves nothing to show.
  if (holder.queue.includes(entry)) announce(holder, deps);
  return entry;
}

/**
 * A provider's report on a native entry. Returns the entry when the AI started reading it: the
 * caller puts it in the conversation. Ids PPM did not queue (the first prompt of a turn) are ignored.
 */
export function applyQueueLifecycle(holder: QueueHolder, id: string, state: QueueLifecycleState, deps: Pick<QueueDeps, "broadcast">): QueuedEntry | undefined {
  if (state !== "started" && state !== "cancelled") return undefined;
  const entry = remove(holder, id);
  if (!entry) return undefined;
  announce(holder, deps);
  return state === "started" ? entry : undefined;
}

/** Takes a message out of the queue (to edit or drop it). Undefined when it is already being read. */
export async function takeBackQueued(holder: QueueHolder, id: string, deps: QueueDeps): Promise<QueuedEntry | undefined> {
  const entry = holder.queue?.find((e) => e.id === id);
  if (!entry) return undefined;
  if (entry.native && !(await deps.provider?.cancelQueuedMessage?.(deps.sessionId, id))) return undefined;
  // The provider's own `cancelled` report may have removed it already.
  remove(holder, id);
  announce(holder, deps);
  return entry;
}

/**
 * Send now. Native entries: the provider has the AI read them now. Held entries are pushed now as
 * one message (Codex steers it into the running turn); they enter the conversation at once, and
 * are returned for the caller to show.
 */
export async function sendQueuedNow(holder: QueueHolder, deps: QueueDeps): Promise<QueuedEntry[]> {
  const queue = holder.queue ?? [];
  if (queue.some((e) => e.native)) await deps.provider?.sendQueuedNow?.(deps.sessionId);
  const allHeld = queue.filter((e) => !e.native);
  const held = allHeld.slice(0, mergeablePrefix(allHeld));
  if (!held.length) return [];
  const merged = mergeEntries(held);
  if (!(await deps.push(merged.content, { images: merged.images, imagePaths: merged.imagePaths, clientMessageId: merged.clientMessageId }))) return [];
  for (const e of held) remove(holder, e.id);
  announce(holder, deps);
  return held;
}

/**
 * Removes and returns what PPM must send itself, as one message: held entries when a turn ends, or
 * every entry (`all`) once the stream is gone, since a provider's own queue died with its process —
 * what is left is held from then on. Entries that cannot share a message stay queued for the next
 * turn's end.
 */
export function drainForDispatch(holder: QueueHolder, deps: Pick<QueueDeps, "broadcast">, all = false): QueuedEntry[] {
  const queue = holder.queue ?? [];
  if (all) for (const e of queue) e.native = false;
  const held = queue.filter((e) => !e.native);
  const out = held.slice(0, mergeablePrefix(held));
  holder.queue = queue.filter((e) => !out.includes(e));
  if (out.length) announce(holder, deps);
  return out;
}

/**
 * Several queued messages as the one message they go out as. Each stored message ends in its own
 * blocks (reply, turn references), and a block decodes only at the end of a message, so the bodies
 * are joined and the blocks re-encoded once. Pass entries {@link mergeablePrefix} allows.
 */
export function mergeEntries(entries: readonly QueuedEntry[]): EnqueueInput {
  const images = entries.flatMap((e) => e.images ?? []);
  const imagePaths = entries.flatMap((e) => e.imagePaths ?? []);
  const content = entries.length === 1 ? entries[0]!.content : (() => {
    const decoded = entries.map((e) => decodeMessageBlocks(e.content));
    const turnRefs = decoded.flatMap((d) => d.turnRefs ?? []);
    return encodeMessageBlocks(joinQueuedContent(decoded.map((d) => d.content)), {
      replyTo: decoded.find((d) => d.replyTo)?.replyTo ?? null,
      turnRefs: turnRefs.length ? turnRefs : null,
    });
  })();
  return {
    content,
    ...(images.length ? { images } : {}),
    ...(imagePaths.length ? { imagePaths } : {}),
    ...(entries.length === 1 && entries[0]!.clientMessageId ? { clientMessageId: entries[0]!.clientMessageId } : {}),
  };
}

/**
 * How many leading entries can go out as one message: a message carries one reply and one valid
 * set of turn references, so a second reply, a turn named twice or too many turns starts the next
 * message. Never less than one.
 */
export function mergeablePrefix(entries: readonly QueuedEntry[]): number {
  let replies = 0;
  const refs: unknown[] = [];
  for (let i = 0; i < entries.length; i++) {
    const d = decodeMessageBlocks(entries[i]!.content);
    replies += d.replyTo ? 1 : 0;
    refs.push(...(d.turnRefs ?? []));
    if (i > 0 && (replies > 1 || d.fromSession || (refs.length && !validateTurnRefs(refs)))) return i;
  }
  return entries.length;
}

