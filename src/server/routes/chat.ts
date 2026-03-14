import { Hono } from "hono";
import { chatService } from "../../services/chat.service.ts";
import { providerRegistry } from "../../providers/registry.ts";
import { ok, err } from "../../types/api.ts";

export const chatRoutes = new Hono();

/** GET /api/chat/providers — list available AI providers */
chatRoutes.get("/providers", (c) => {
  try {
    return c.json(ok(providerRegistry.list()));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** GET /api/chat/sessions — list all chat sessions */
chatRoutes.get("/sessions", async (c) => {
  try {
    const providerId = c.req.query("providerId");
    const sessions = await chatService.listSessions(providerId);
    return c.json(ok(sessions));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** GET /api/chat/sessions/:id/messages — get message history */
chatRoutes.get("/sessions/:id/messages", (c) => {
  try {
    const id = c.req.param("id");
    const providerId = c.req.query("providerId") ?? "claude";
    const messages = chatService.getMessages(providerId, id);
    return c.json(ok(messages));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** POST /api/chat/sessions — create a new session */
chatRoutes.post("/sessions", async (c) => {
  try {
    const body = await c.req.json<{
      providerId?: string;
      projectName?: string;
      title?: string;
    }>();
    const session = await chatService.createSession(body.providerId, {
      projectName: body.projectName,
      title: body.title,
    });
    return c.json(ok(session), 201);
  } catch (e) {
    return c.json(err((e as Error).message), 400);
  }
});

/** DELETE /api/chat/sessions/:id — delete a session */
chatRoutes.delete("/sessions/:id", async (c) => {
  try {
    const id = c.req.param("id");
    const providerId = c.req.query("providerId") ?? "claude";
    await chatService.deleteSession(providerId, id);
    return c.json(ok({ deleted: id }));
  } catch (e) {
    return c.json(err((e as Error).message), 404);
  }
});
