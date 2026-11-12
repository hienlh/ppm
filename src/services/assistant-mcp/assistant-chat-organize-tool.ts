import type { Json } from "../mcp-http-endpoint.ts";
import { CHAT_ORGANIZE_TOOL } from "../../shared/assistant-chat-tool-names.ts";
import type { AssistantProvenance } from "../../shared/assistant-provenance.ts";
import { UNATTENDED_TURN_REFUSAL } from "../chat-control/chat-control.ts";
import { chatOrganizeSummary, type OrganizeChange } from "./assistant-approval-summary-chat.ts";
import { resolveChatIn, type ChatTarget, type ChatToolDeps } from "./assistant-chat-tool-target.ts";
import { applyOrganizeChanges, parseOrganizeChanges, type AskedChange } from "./assistant-chat-organize-apply.ts";
import { resolveAssistantProject, type AssistantProject } from "./assistant-project-scope.ts";
import { projectRoute } from "./assistant-route-rules.ts";
import type { ToolContext } from "./assistant-tool-family.ts";
import { clip, errorResult, jsonResult, notApprovedResult } from "./assistant-tool-output.ts";

/**
 * `chat_organize`: rename, pin, tag and mark chats read, through the routes PPM's session list
 * calls. In a clean turn — the user started it, and nothing the user did not write has reached it
 * — it runs at once, as the user's own request. Otherwise one card covers the whole call, and it
 * is refused outright in a turn PPM started on its own. Marking a chat read is refused while that
 * chat shows a card, so the sign that it needs the user cannot be cleared from here.
 */

type Tag = { id: number; name: string };

/** The provenance read before this call marked the turn; unknown is not clean. */
export function isCleanTurn(p: AssistantProvenance | undefined): boolean {
  return !!p && !p.untrusted && (p.startedBy === "user_ppm" || p.startedBy === "user_telegram");
}

export interface PlannedChange {
  chat: ChatTarget;
  change: OrganizeChange;
  tagId?: number | null;
}

async function readTags(ctx: ToolContext, project: AssistantProject): Promise<Tag[] | string> {
  const r = await ctx.callRoute<{ tags?: Tag[] }>("GET", projectRoute(project.name, "tags"));
  return r.ok && Array.isArray(r.data?.tags) ? r.data!.tags : `Could not read the project's tags: ${r.error ?? `PPM answered ${r.status}`}`;
}

function findTag(tags: Tag[], name: string): Tag | string {
  const exact = tags.find((t) => t.name === name);
  if (exact) return exact;
  const loose = tags.filter((t) => t.name.toLowerCase() === name.toLowerCase());
  if (loose.length === 1) return loose[0]!;
  return `The project has no tag named "${clip(name, 60)}"; its tags are: ${tags.map((t) => t.name).join(", ") || "(none)"}.`;
}

/** Each asked change checked against the chat as PPM records it now, reduced to what differs. */
async function plan(ctx: ToolContext, project: AssistantProject, asked: AskedChange[], deps: ChatToolDeps): Promise<PlannedChange[] | string> {
  const tags = asked.some((a) => typeof a.tag === "string") ? await readTags(ctx, project) : [];
  if (typeof tags === "string") return tags;
  const planned: PlannedChange[] = [];
  for (const a of asked) {
    const found = await resolveChatIn(project, a.sessionId, deps);
    if (!found.ok) return found.error;
    const chat = found.value;
    const { facts } = chat;
    if (a.title !== undefined && facts.manager) return `"${chat.name}" is the project's manager chat; its title is left to the user.`;
    if (a.read === true && deps.control()?.liveState(chat.sessionId)?.card) {
      return `"${chat.name}" is waiting for the user to answer a card; it is not marked read while that card waits.`;
    }
    const change: OrganizeChange = {};
    let tagId: number | null | undefined;
    if (a.title !== undefined && a.title !== facts.title) change.title = a.title;
    if (a.pinned !== undefined && a.pinned !== facts.pinned) change.pinned = a.pinned;
    if (a.tag === null && facts.tag) [change.tag, tagId] = [null, null];
    if (typeof a.tag === "string") {
      const tag = findTag(tags, a.tag);
      if (typeof tag === "string") return tag;
      if (tag.id !== facts.tag?.id) [change.tag, tagId] = [tag.name, tag.id];
    }
    if (a.read !== undefined) change.read = a.read;
    planned.push({ chat, change, ...(tagId !== undefined ? { tagId } : {}) });
  }
  return planned;
}

const shape = (planned: PlannedChange[]) => JSON.stringify(planned.map((p) => [p.chat.sessionId, p.change, p.tagId]));
const hasChange = (p: PlannedChange) => Object.keys(p.change).length > 0;

export async function chatOrganize(ctx: ToolContext, args: Record<string, unknown>, deps: ChatToolDeps): Promise<Json> {
  if (deps.unattended(ctx.sessionId)) return errorResult(UNATTENDED_TURN_REFUSAL);
  const found = resolveAssistantProject(args.project, () => deps.projects());
  if (!found.ok) return errorResult(found.error);
  const project = found.value;
  const asked = parseOrganizeChanges(args.changes);
  if (typeof asked === "string") return errorResult(asked);

  const planned = await plan(ctx, project, asked, deps);
  if (typeof planned === "string") return errorResult(`Nothing changed: ${planned}`);
  const effective = planned.filter(hasChange);
  if (effective.length === 0) return jsonResult({ outcome: "unchanged", note: "Every chat already is as asked." });

  let toApply = effective;
  if (!isCleanTurn(ctx.provenanceAtCall)) {
    const verdict = await ctx.ask({
      tool: CHAT_ORGANIZE_TOOL,
      input: { project: project.name, changes: effective.map((p) => ({ sessionId: p.chat.sessionId, ...p.change })) },
      summary: chatOrganizeSummary({
        project: project.name, entries: effective.map((p) => ({ sessionId: p.chat.sessionId, title: p.chat.facts.title, change: p.change })),
      }),
    });
    if (verdict.verdict !== "approved") return notApprovedResult(CHAT_ORGANIZE_TOOL, verdict);
    // The card showed these chats as they stood; any of them may have changed since.
    const again = await plan(ctx, project, asked, deps);
    if (typeof again === "string") return errorResult(`Nothing changed: ${again}`);
    toApply = again.filter(hasChange);
    if (shape(toApply) !== shape(effective)) {
      return errorResult("Nothing changed: some of these chats changed while the card waited. Read them again and ask again if still needed.");
    }
  }
  return applyOrganizeChanges(ctx, project, toApply, deps);
}
