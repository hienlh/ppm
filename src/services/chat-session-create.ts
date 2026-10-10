import { chatService } from "./chat.service.ts";
import { setSessionClearedFrom, setSessionDesignSlug } from "./db.service.ts";
import { bindPickedAccount } from "./picked-account-binding.ts";
import { getProjectDefaultTagId, setSessionTag } from "./tag.service.ts";
import { isValidDesignSlug } from "./design/design-slug.ts";
import type { Session } from "../types/chat.ts";

/**
 * Creating a chat in a project, the one way both the new-chat route and the Assistant's
 * `chat_start` do it, so a chat the Assistant opens is set up exactly like one the user opens:
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

export async function createProjectChatSession(input: CreateProjectChatInput): Promise<Session> {
  const session = await chatService.createSession(input.providerId, {
    projectName: input.projectName,
    projectPath: input.projectPath,
    title: input.title,
    adoptWarmSpare: input.adoptWarmSpare,
  });
  if (input.clearedFrom) setSessionClearedFrom(session.id, input.clearedFrom);
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
