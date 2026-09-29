/**
 * Client for `POST /chat/prepare` — the single request a sessionless chat tab fires on
 * mount. One in-flight (or recently settled) promise per tab id; everything the response
 * carries is fanned out into the caches each part would otherwise have fetched
 * separately (settings, provider list, slash items, tags, usage, the account claim), so
 * none of those fire their own network call while this one covers them.
 *
 * The promise is kept for a while after it settles rather than deleted the instant it
 * resolves — a consumer that mounts a beat later (useUsage's deferred timer, a slash
 * picker opened right after) still joins the same answer instead of starting a
 * redundant request.
 *
 * Two facts outlive that join window, because they must not be re-learned by asking the
 * server again: that the tab's current sessionless stretch is already prepared (so a
 * remount does not POST — and consume an account pick — a second time), and that its
 * pick came back with no usable account (so the claim hook does not POST `/pick` to be
 * told the same thing). Both are dropped by `forgetPrepare` once the tab has a session.
 */
import { api, projectUrl } from "./api-client";
import { CHAT_PREPARATION_TIMEOUT_MS, seedChatProviders, type ChatProviderInfo } from "./chat-preparation-cache";
import { writeChatPreparationSettings, writeChatProviders } from "./chat-preference-local-cache";
import { projectCacheId, type ProjectCacheRef } from "./browser-cache/cache-keys";
import { seedSlashItems, registerPendingSlash, type SlashItemsPayload } from "./slash-items-cache";
import { useSessionListStore, type SessionTagsState } from "@/stores/session-list-store";
import { seedUsage, usageScopeKey } from "@/hooks/use-usage";
import { applyAccountClaim } from "@/hooks/use-chat-account-claim";
import type { ChatPreparationSettings } from "../../shared/chat-preparation-settings";
import type { UsageInfo } from "../../types/chat";

export interface PickedAccount { id: string; label: string | null }
export type PrepareDraft = { content: string; attachments: string; updatedAt: string } | null;

export interface PreparedChat {
  resolvedProviderId: string;
  providerId: string;
  settings: ChatPreparationSettings;
  providers: ChatProviderInfo[];
  pickedAccount: PickedAccount | null | "timeout" | "skipped";
  usage: (UsageInfo & { lastFetchedAt?: string }) | null;
  draft: PrepareDraft;
  tags: SessionTagsState | null;
  slash: SlashItemsPayload | null;
}

export interface PrepareRequestBody {
  providerId?: string;
  focusedProvider?: string;
  skipPick?: boolean;
}

/** Sends the prepare request. Replaceable in tests, which otherwise depend on whichever
 * `api-client` module another test file in the same process left mocked. */
export type PrepareTransport = (path: string, body: PrepareRequestBody, signal: AbortSignal) => Promise<PreparedChat>;
const defaultTransport: PrepareTransport = (path, body, signal) => api.post<PreparedChat>(path, body, { signal });
let transport: PrepareTransport = defaultTransport;

const inFlight = new Map<string, Promise<PreparedChat>>();
/** Tabs whose current sessionless stretch already has a successful prepare. */
const prepared = new Set<string>();
/** Tab id → the provider for which prepare's pick found no usable account. */
const pickedNoAccount = new Map<string, string>();

/** Idempotent per tab id — a second call before the first settles (or within its
 * post-settle join window) returns the same promise instead of firing a new POST. */
export function startPrepare(tabId: string, project: ProjectCacheRef, body: PrepareRequestBody): Promise<PreparedChat> {
  const existing = inFlight.get(tabId);
  if (existing) return existing;
  const promise = transport(`${projectUrl(project.name)}/chat/prepare`, body, AbortSignal.timeout(CHAT_PREPARATION_TIMEOUT_MS))
    .then((result) => {
      // A tab that got its session (or was forgotten) while this was in flight has
      // moved on: its caches may still be seeded, but its claim and flags must not be.
      if (inFlight.get(tabId) === promise) {
        prepared.add(tabId);
        applyPrepared(tabId, project, result);
      } else {
        applyShared(project, result);
      }
      return result;
    });
  inFlight.set(tabId, promise);
  // Only worth registering when the provider is already known — a still-pending tab's
  // composer will not call fetchSlashItems until the gate resolves it, by which point
  // this same promise has already seeded the cache directly (see applyPrepared).
  if (body.providerId) {
    registerPendingSlash(project.name, body.providerId, promise.then((result) => result.slash, () => null));
  }
  // Both branches handled: a failed prepare is reported to whoever awaits `promise`,
  // and this bookkeeping chain must not surface it a second time as unhandled.
  const expire = () => {
    setTimeout(() => { if (inFlight.get(tabId) === promise) inFlight.delete(tabId); }, CHAT_PREPARATION_TIMEOUT_MS);
  };
  promise.then(expire, expire);
  return promise;
}

/** The tab's in-flight (or recently settled) prepare, or undefined when none was started. */
export function getPrepare(tabId: string | undefined): Promise<PreparedChat> | undefined {
  return tabId ? inFlight.get(tabId) : undefined;
}

/** Whether this tab's current sessionless stretch was already prepared successfully —
 * true even after the join window, so a remount does not prepare (and pick) again. */
export function isPrepared(tabId: string): boolean {
  return prepared.has(tabId);
}

/** True when this tab's prepare already asked for an account on `provider` and was told
 * none is usable. That answer is final for the tab: asking `/pick` again would either get
 * the same null or, worse, advance another provider's round-robin. */
export function prepareFoundNoAccount(tabId: string, provider: string): boolean {
  return pickedNoAccount.get(tabId) === provider;
}

/**
 * Drops everything kept for a tab once it has a session. From then on nothing may join
 * the old answer: a design tab's `/clear` remounts under the same tab id, and joining
 * would restore the `__new__` draft that was just sent and reapply stale settings.
 */
export function forgetPrepare(tabId: string): void {
  inFlight.delete(tabId);
  prepared.delete(tabId);
  pickedNoAccount.delete(tabId);
}

/** Test-only escape hatch: tab ids are reused across `it()` blocks that share a
 * fixture, and this module's dedupe is keyed on them for real minutes at a time in
 * production. Production code never calls this. */
export function __clearPrepareForTest(): void {
  inFlight.clear();
  prepared.clear();
  pickedNoAccount.clear();
}

/** Test-only: what the join window's own timer does after 30 s, without the wait. */
export function __expirePrepareJoinForTest(tabId: string): void {
  inFlight.delete(tabId);
}

/** Test-only: route the request through `fn` (or back to the real API with null). */
export function __setPrepareTransportForTest(fn: PrepareTransport | null): void {
  transport = fn ?? defaultTransport;
}

/** The caches keyed by project or provider — true for any tab of that project. */
function applyShared(project: ProjectCacheRef, result: PreparedChat): void {
  writeChatPreparationSettings(result.settings);
  writeChatProviders(projectCacheId(project), result.providers);
  seedChatProviders(project.name, result.providers);
  if (result.tags) useSessionListStore.getState().seedTags(project, result.tags);
  if (result.slash) seedSlashItems(project, result.providerId, result.slash);
}

function applyPrepared(tabId: string, project: ProjectCacheRef, result: PreparedChat): void {
  applyShared(project, result);

  // "timeout"/"skipped" carry no account to apply; only "timeout" leaves the claim hook
  // to pick again. A real pick is written into the tab's metadata, and an explicit null
  // (nothing usable, or a provider without managed accounts) is remembered as final.
  if (result.pickedAccount === null) pickedNoAccount.set(tabId, result.providerId);
  const claimed = result.pickedAccount && result.pickedAccount !== "timeout" && result.pickedAccount !== "skipped"
    ? result.pickedAccount : null;
  applyAccountClaim(tabId, result.providerId, claimed);

  if (result.usage) {
    seedUsage(usageScopeKey(project.name, result.providerId, undefined, claimed?.id), result.usage, result.usage.lastFetchedAt ?? null, claimed?.id);
  }
}
