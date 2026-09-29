import { Hono } from "hono";
import { ok, err } from "../../types/api.ts";
import { prepareNewChat, UnknownProviderError, type PrepareChatBody } from "../../services/chat-prepare/chat-prepare.service.ts";

type Env = { Variables: { projectPath: string; projectName: string } };

export const chatPrepareRoutes = new Hono<Env>();

/**
 * POST /chat/prepare — everything a sessionless chat tab needs, in one budgeted request.
 * Each part runs under its own time budget, so a slow part comes back null/"timeout" instead
 * of delaying the rest; no part is ever consumed twice (see chat-prepare.service.ts).
 */
chatPrepareRoutes.post("/", async (c) => {
  try {
    const projectPath = c.get("projectPath");
    const body = await c.req.json<PrepareChatBody>().catch(() => ({}) as PrepareChatBody);
    const result = await prepareNewChat(projectPath, body);
    return c.json(ok(result));
  } catch (e) {
    if (e instanceof UnknownProviderError) return c.json(err(e.message), 400);
    return c.json(err((e as Error).message), 500);
  }
});
