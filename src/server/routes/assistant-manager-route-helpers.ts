import { ManagerChatError } from "../../services/assistant-managers/manager-chats.service.ts";
import { MainSessionError } from "../../services/assistant/assistant-main-session.ts";

/** A request body that must be a JSON object; null for anything else. */
export async function readJsonObject(c: { req: { json: () => Promise<unknown> } }): Promise<Record<string, unknown> | null> {
  try {
    const body = await c.req.json();
    return body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** The status and message a manager or main-session route answers an error with. */
export function managerRouteFailure(e: unknown): { message: string; status: 400 | 404 | 500 } {
  if (e instanceof ManagerChatError) return { message: e.message, status: e.status };
  if (e instanceof MainSessionError) return { message: e.message, status: 400 };
  return { message: (e as Error).message, status: 500 };
}
