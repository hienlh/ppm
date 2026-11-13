import { chatService } from "./chat.service.ts";
import { getSessionProjectPath, resolveMigratedSession, setSessionClearedFrom, setSessionDesignSlug } from "./db.service.ts";
import { isAssistantProject } from "../shared/assistant-project.ts";
import { projectKey } from "./project-name-for-path.ts";
import { bindPickedAccount } from "./picked-account-binding.ts";
import { getProjectDefaultTagId, setSessionTag } from "./tag.service.ts";
import { isValidDesignSlug } from "./design/design-slug.ts";
import { BINDING_CLAUDE_ONLY, copyBindingToFork, isBoundSession, providerSupportsBinding } from "./extension-session-binding.service.ts";
import { providerRegistry } from "../providers/registry.ts";
import type { Session } from "../types/chat.ts";

/**
 * Creating a chat in a project, the one way both the new-chat route and the Assistant's
 * `create_session` do it, so a chat the Assistant opens is set up exactly like one the user opens:
 * the same provider record, the same project default tag, the same account binding rules.
 * Callers validate their own input first (the route its request body, the tool its arguments).
 */
export interface CreateProjectChatInput {
  providerId?: string;
  projectName: string;
  projectPath: string;
  title?: string;
  /** Reuse a pre-started process. Never for a chat whose instructions or mode differ from an ordinary one. */
  adoptWarmSpare: boolean;
  clearedFrom?: string;
  /** Already checked with `isValidDesignSlug`. */
  designSlug?: string;
  /** An account the creating tab showed; advisory, re-checked against the server's own pool. */
  accountId?: string;
}

/** The project the cleared chat belongs to: the live session's, else the one recorded for it. */
function clearedFromProjectPath(clearedFrom: string): string | null {
  const id = resolveMigratedSession(clearedFrom);
  return chatService.getSession(id)?.projectPath ?? getSessionProjectPath(id);
}

export async function createProjectChatSession(input: CreateProjectChatInput): Promise<Session> {
  // `/clear` in a chat an extension bound clears the context, not the binding: the new chat is
  // the same extension's, with the same instructions and tool limits. A provider that cannot hold
  // a binding is refused rather than given an unbound chat with every tool.
  // Only an ordinary chat continues one: `clearedFrom` comes from the client, and an Assistant or
  // design chat, or a chat of a project the cleared one is known not to belong to, is never an
  // extension's. A cleared chat whose project PPM no longer knows (no live session, nothing
  // recorded) still passes its binding on, so the new chat keeps the limits rather than lose them.
  const sourceProject = input.clearedFrom ? clearedFromProjectPath(input.clearedFrom) : null;
  const clearsBound = !!input.clearedFrom && isBoundSession(input.clearedFrom)
    && !input.designSlug && !isAssistantProject(input.projectName)
    && (!sourceProject || projectKey(sourceProject) === projectKey(input.projectPath));
  if (clearsBound && !providerSupportsBinding(input.providerId ?? providerRegistry.getDefault().id)) {
    throw new Error(`This chat is managed by an extension, and only Claude can run it (${BINDING_CLAUDE_ONLY})`);
  }
  const session = await chatService.createSession(input.providerId, {
    projectName: input.projectName,
    projectPath: input.projectPath,
    title: input.title,
    // A bound chat never adopts a spare: the spare was started without the binding.
    adoptWarmSpare: input.adoptWarmSpare && !clearsBound,
  });
  if (input.clearedFrom) setSessionClearedFrom(session.id, input.clearedFrom);
  if (clearsBound) {
    try {
      copyBindingToFork(input.clearedFrom!, session.id);
    } catch (e) {
      // A chat that should be bound and is not would run with every tool: it goes instead.
      await chatService.deleteSession(session.providerId, session.id).catch(() => {});
      throw e;
    }
  }
  if (input.designSlug && isValidDesignSlug(input.designSlug)) setSessionDesignSlug(session.id, input.designSlug);
  // The tab claimed an account when it opened and showed its name; honour that here so the
  // first message runs on the account the user was actually looking at. Advisory, never
  // authoritative: bindPickedAccount re-checks the id against the server's own pool and simply
  // declines an id it does not recognise, because selecting a token by a client-supplied id is
  // not something to allow.
  if (input.accountId) bindPickedAccount(session.id, session.providerId, input.accountId);
  const defaultTagId = getProjectDefaultTagId(input.projectPath);
  if (defaultTagId) setSessionTag(session.id, defaultTagId, input.projectPath);
  return session;
}
