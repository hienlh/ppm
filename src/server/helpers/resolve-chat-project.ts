import { isAssistantProject } from "../../shared/assistant-project.ts";
import { ensureAssistantWorkDir } from "../../services/assistant/assistant-work-dir.ts";
import { resolveProjectPath } from "./resolve-project.ts";

/**
 * {@link resolveProjectPath} for the chat path only — the chat WebSocket and the `/chat`
 * sub-router — which alone also accepts the Assistant's virtual project and answers with its
 * work directory. Everything else keeps calling `resolveProjectPath`, which never knows the
 * name, so the virtual project cannot be opened as a terminal, an LSP root or a file tree.
 */
export function resolveChatProjectPath(name: string): string {
  if (isAssistantProject(name)) return ensureAssistantWorkDir();
  return resolveProjectPath(name);
}

/**
 * The same refusal any unregistered name gets, for the non-chat doors that resolve a project
 * name themselves. `resolveProjectPath` would already refuse the name in practice, but it falls
 * back to treating an unknown name as a relative path, and `<cwd>/__assistant__` lands inside a
 * registered project when one is registered at (or above) the server's working directory.
 */
export function assertNotAssistantProject(name: string | null | undefined): void {
  if (isAssistantProject(name)) throw new Error(`Project not found: ${name}`);
}
