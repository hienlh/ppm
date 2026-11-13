import { Hono } from "hono";
import { resolve } from "node:path";
import { deleteChatSession } from "../../services/chat-session-admin.ts";
import { getSessionProjectName, getSessionProjectPath, getSessionProvider } from "../../services/db.service.ts";
import { realPathOrSelfSync } from "../../services/fs-ops/fs-real-path.ts";
import { hasChildren } from "../../services/session-branch.service.ts";
import { managerChats } from "../../services/assistant-managers/manager-chats.service.ts";
import { chatControl } from "../../services/chat-control/chat-control.ts";
import { waitTurnIdle, type WaitTurnIdleOptions } from "../../services/chat-control/wait-turn-idle.ts";
import { ok, err } from "../../types/api.ts";

type Env = { Variables: { projectPath: string; projectName: string } };

/**
 * `DELETE /chat/sessions/:id` — deletes one chat and every row PPM keeps about it.
 *
 * - A chat PPM recorded under another project is answered 404, as if it did not exist: the route
 *   is reached through this project's name, and must not delete what that project does not hold.
 * - The provider is the one stored for the chat unless the caller names one, so a Codex chat is
 *   not handed to Claude's cleanup.
 * - `?stopRunning=1` (the `ppm` CLI, the Assistant's tool): a running turn is stopped first, and
 *   the chat is deleted only once the turn is over. A turn that does not stop within the wait is
 *   a 409 and nothing is deleted. A project's manager chat is refused on this path: its role is
 *   ended from PPM's own screens, never as a side effect of a command.
 *
 * Tests pass `c.env.chatDeleteWait` to shorten the wait.
 */
export const CHAT_DELETE_WAIT_ENV_KEY = "chatDeleteWait";

export const chatSessionDeleteRoutes = new Hono<Env>();

/**
 * Paths compared the way the project lookup compares them: by real path (a junction, a symlink
 * or another spelling of the same folder is the same project), case-blind on Windows and macOS.
 */
export function samePath(a: string, b: string, platform: string = process.platform): boolean {
  const [x, y] = [realPathOrSelfSync(resolve(a)), realPathOrSelfSync(resolve(b))];
  return platform === "win32" || platform === "darwin" ? x.toLowerCase() === y.toLowerCase() : x === y;
}

/**
 * Whether the chat belongs to the project the route was reached through: recorded under its
 * folder, or under its name. A moved project keeps its name while its chats keep the folder they
 * were recorded under, which no longer matches.
 */
function heldByProject(id: string, projectPath: string, projectName: string): boolean {
  const recorded = getSessionProjectPath(id);
  if (!recorded || samePath(recorded, projectPath)) return true;
  return getSessionProjectName(id) === projectName;
}

function waitOptions(env: unknown): WaitTurnIdleOptions {
  const own = env && typeof env === "object" ? (env as Record<string, unknown>)[CHAT_DELETE_WAIT_ENV_KEY] : undefined;
  return own && typeof own === "object" ? (own as WaitTurnIdleOptions) : {};
}

chatSessionDeleteRoutes.delete("/sessions/:id", async (c) => {
  const id = c.req.param("id");
  try {
    if (!heldByProject(id, c.get("projectPath"), c.get("projectName"))) return c.json(err("Session not found"), 404);
    const providerId = c.req.query("providerId") || getSessionProvider(id) || "claude";
    // Leaf-only: a session with edited versions branched from it cannot be
    // deleted (would orphan its children). Reparenting is out of scope.
    if (hasChildren(id)) {
      return c.json(err("Cannot delete: this session has edited versions branched from it"), 409);
    }
    if (c.req.query("stopRunning") === "1") {
      if (managerChats.isManagerChat(id)) {
        return c.json(err("This is the project's manager chat; delete it from PPM's session list, which ends that role"), 409);
      }
      const control = chatControl();
      if (control?.liveState(id)?.running) {
        control.cancelTurn(id, "delete");
        const stopped = await waitTurnIdle(() => control.liveState(id)?.running === true, waitOptions(c.env));
        if (!stopped) return c.json(err("The turn did not stop, so the chat was not deleted"), 409);
      }
    }
    await deleteChatSession(providerId, id, c.get("projectPath"));
    return c.json(ok({ deleted: id }));
  } catch (e) {
    return c.json(err((e as Error).message), 404);
  }
});
