/**
 * PPM Assistant sessions live in a virtual project that no user can register. Only the chat
 * path (the chat WebSocket and the `/chat` sub-router) resolves this name — to an empty work
 * directory under the PPM dir — and every other project-scoped route (terminal, LSP, git,
 * files, workspace, designs, previews) refuses it, so an Assistant session never gains a
 * terminal or a file tree rooted in PPM's own directory.
 */
export const ASSISTANT_PROJECT_NAME = "__assistant__";

export function isAssistantProject(name: string | null | undefined): boolean {
  return name === ASSISTANT_PROJECT_NAME;
}
