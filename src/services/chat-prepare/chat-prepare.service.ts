import { configService } from "../config.service.ts";
import { providerRegistry } from "../../providers/registry.ts";
import { resolveNewChatProvider } from "../../shared/new-chat-provider.ts";
import type { ChatPreparationSettings } from "../../shared/chat-preparation-settings.ts";
import { pickClaudeAccount, pickCodexAccount, type PickedAccount } from "../account-pick.service.ts";
import { readUsageSnapshot, type ChatUsageSnapshot } from "../chat-usage-snapshot.service.ts";
import { draftService, type DraftData } from "../draft.service.ts";
import { getTagsByProject, getTagSessionCounts, getProjectDefaultTagId } from "../tag.service.ts";
import { getSlashRecents } from "../db.service.ts";
import { listSlashItemsForProvider } from "../slash-items-for-provider.ts";
import type { SlashItem } from "../slash-discovery/types.ts";
import { settleWithinBudget } from "./settle-within-budget.ts";

const SLASH_BUDGET_MS = 400;
const CODEX_USAGE_PICK_BUDGET_MS = 1500;
const USAGE_BUDGET_MS = 800;
/** "Effectively instant" (SQLite/memory) parts still get a defensive cap. */
const DEFAULT_BUDGET_MS = 1000;

export interface PrepareChatBody {
  providerId?: string;
  focusedProvider?: string;
  skipPick?: boolean;
}

export interface PrepareTagsSnapshot {
  tags: ReturnType<typeof getTagsByProject>;
  counts: ReturnType<typeof getTagSessionCounts>;
  defaultTagId: number | null;
}

export interface PrepareSlashSnapshot {
  items: SlashItem[];
  recentNames: string[];
}

export interface PrepareChatResult {
  resolvedProviderId: string;
  providerId: string;
  settings: ChatPreparationSettings;
  providers: { id: string; name: string }[];
  pickedAccount: PickedAccount | null | "timeout" | "skipped";
  usage: ChatUsageSnapshot | null;
  draft: DraftData | null;
  tags: PrepareTagsSnapshot | null;
  slash: PrepareSlashSnapshot | null;
}

export class UnknownProviderError extends Error {
  constructor(providerId: string) {
    super(`Provider "${providerId}" not found`);
  }
}

/** Only provider selection and permissions are retained; never api_key/api_key_env. */
function toChatPreparationSettings(): ChatPreparationSettings {
  const ai = configService.get("ai");
  return {
    default_provider: ai.default_provider,
    new_chat_provider_mode: ai.new_chat_provider_mode,
    providers: Object.fromEntries(
      Object.entries(ai.providers).map(([id, provider]) => [id, { permission_mode: provider.permission_mode }]),
    ),
  };
}

/**
 * Everything a sessionless chat tab needs, in one budgeted request.
 *
 * `settings` and `providers` come from in-memory/config reads that cannot meaningfully hang,
 * so they are never null. Draft, tags and slash items each run under their own budget and
 * fall back to null rather than delay the response — a timed-out one keeps running in the
 * background to warm its own cache for the next request. The account pick and its usage run
 * in parallel with those parts but in sequence with each other: usage has to be read for
 * whichever account was just picked, and Codex's pick itself is budgeted so a slow usage
 * fetch never blocks past its own window (see `account-pick.service.ts`).
 */
export async function prepareNewChat(projectPath: string, body: PrepareChatBody): Promise<PrepareChatResult> {
  const settings = toChatPreparationSettings();
  const resolvedProviderId = resolveNewChatProvider(settings, body.focusedProvider);
  const providerId = body.providerId || resolvedProviderId;
  if (!providerRegistry.get(providerId)) throw new UnknownProviderError(providerId);

  const providers = providerRegistry.list();

  const [draft, tags, slash, account] = await Promise.all([
    settleWithinBudget(
      (async () => draftService.get(projectPath, "__new__"))(),
      DEFAULT_BUDGET_MS,
      null,
    ),
    settleWithinBudget(
      (async (): Promise<PrepareTagsSnapshot> => ({
        tags: getTagsByProject(projectPath),
        counts: getTagSessionCounts(projectPath),
        defaultTagId: getProjectDefaultTagId(projectPath),
      }))(),
      DEFAULT_BUDGET_MS,
      null,
    ),
    settleWithinBudget(
      listSlashItemsForProvider(projectPath, providerId, undefined).then(
        (items): PrepareSlashSnapshot => ({ items, recentNames: getSlashRecents(projectPath) }),
      ),
      SLASH_BUDGET_MS,
      null,
    ),
    body.skipPick
      ? Promise.resolve({ pickedAccount: "skipped" as const, usage: null })
      : pickAccountWithUsage(providerId),
  ]);

  return { resolvedProviderId, providerId, settings, providers, ...account, draft, tags, slash };
}

/**
 * The pick, then the usage of whichever account it picked. Sequential by nature — the
 * usage read needs the picked id — but run as one part beside draft, tags and slash, so
 * the slowest of those never delays it. A throw from the pick itself propagates, as it
 * always has: the route answers it with a 500 rather than a tab without an account.
 */
async function pickAccountWithUsage(providerId: string): Promise<Pick<PrepareChatResult, "pickedAccount" | "usage">> {
  let pickedAccount: PickedAccount | null | "timeout";
  if (providerId === "codex") {
    pickedAccount = await pickCodexAccount({ usageBudgetMs: CODEX_USAGE_PICK_BUDGET_MS });
  } else if (providerId === "claude") {
    pickedAccount = pickClaudeAccount();
  } else {
    pickedAccount = null;
  }
  const usage: ChatUsageSnapshot | null = pickedAccount && pickedAccount !== "timeout"
    ? await settleWithinBudget(readUsageSnapshot(providerId, { accountId: pickedAccount.id }), USAGE_BUDGET_MS, null)
    : null;
  return { pickedAccount, usage };
}
