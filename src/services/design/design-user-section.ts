import { createHash } from "node:crypto";
import {
  extractSkillMentions, resolveSkillMentions, type MentionResolution,
} from "../../shared/design-skill-mentions.ts";
import { withTimeout } from "../mcp-oauth/mcp-control-query.ts";
import { getDesignInstructions } from "./design-settings.service.ts";
import { listProviderSkills } from "./design-skill-sources.ts";
import { buildUserDesignSection, type DesignSkillRuntime } from "./design-user-instructions.ts";

/**
 * Sections already built, per session and text. Every turn of a design session asks, and
 * resolving a codex skill spawns an app-server once its short list cache has lapsed; the
 * instructions only matter when the provider starts or resumes the session anyway (Claude
 * snapshots its system prompt, codex reads developer instructions on connect), so an
 * answer is reused for the session until the saved text changes.
 */
const cache = new Map<string, string>();
const CACHE_LIMIT = 256;

/**
 * A listing that failed is not retried on every turn. A codex that cannot start would
 * otherwise spawn another app-server for each turn and follow-up of every design session —
 * the retry flood that once kept the server from answering its own health check.
 */
const failedUntil = new Map<string, number>();
const FAILURE_BACKOFF_MS = 60_000;
/** The listing sits in front of the turn; past this the turn goes ahead without it. */
const LIST_TIMEOUT_MS = 5_000;

function remember(key: string, section: string): string {
  cache.delete(key);
  cache.set(key, section);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  return section;
}

export interface UserSectionRequest {
  providerId: string;
  sessionId: string;
  projectPath?: string | null;
  slug: string;
}

/**
 * The runtime and resolved mentions for one session, or `skills: null` when the list could
 * not be read. An empty codex list counts as unread — codex reports its own system skills
 * whenever it is up — while an empty Claude list is a machine with no Claude skills.
 */
async function resolveMentions(req: UserSectionRequest, mentions: string[]): Promise<{ runtime: DesignSkillRuntime; skills: MentionResolution | null }> {
  const backoffKey = `${req.providerId}\0${req.sessionId}`;
  if ((failedUntil.get(backoffKey) ?? 0) > Date.now()) return { runtime: "claude", skills: null };
  try {
    const listed = await withTimeout(
      listProviderSkills(req.providerId, { projectPath: req.projectPath, sessionId: req.sessionId }),
      LIST_TIMEOUT_MS, "skill listing timed out");
    if (listed.items.length || listed.runtime === "claude") {
      failedUntil.delete(backoffKey);
      return { runtime: listed.runtime, skills: resolveSkillMentions(mentions, listed.items) };
    }
  } catch (e) {
    console.warn(`[design] could not list skills for ${req.providerId}: ${(e as Error).message}`);
  }
  failedUntil.set(backoffKey, Date.now() + FAILURE_BACKOFF_MS);
  if (failedUntil.size > CACHE_LIMIT) failedUntil.delete(failedUntil.keys().next().value!);
  return { runtime: "claude", skills: null };
}

/**
 * The user's design-instructions section for one design session, or "" when there is no
 * saved text. Never throws: a turn must not fail because a skill list could not be read —
 * the text is then delivered with its names marked unchecked rather than with wrong lines.
 */
export async function userDesignSectionFor(req: UserSectionRequest): Promise<string> {
  let text: string;
  try {
    text = getDesignInstructions();
  } catch (e) {
    console.warn(`[design] could not read design instructions: ${(e as Error).message}`);
    return "";
  }
  if (!text) return "";
  const dir = `designs/${req.slug}/`;
  const key = createHash("sha256")
    .update([req.providerId, req.sessionId, req.projectPath ?? "", req.slug, text].join("\0"))
    .digest("hex");
  const hit = cache.get(key);
  if (hit !== undefined) return hit;

  const mentions = extractSkillMentions(text);
  if (!mentions.length) return remember(key, buildUserDesignSection({ text, dir, runtime: "claude", skills: null }));

  const { runtime, skills } = await resolveMentions(req, mentions);
  const section = buildUserDesignSection({ text, dir, runtime, skills });
  // An unread list is not cached, so the first turn after the back-off can still resolve.
  return skills ? remember(key, section) : section;
}
