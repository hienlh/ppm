import { Hono } from "hono";
import { chatService } from "../../services/chat.service.ts";
import { providerRegistry } from "../../providers/registry.ts";
import { ok, err } from "../../types/api.ts";

type Env = { Variables: { projectPath: string; projectName: string } };

export const chatRoutes = new Hono<Env>();

/** GET /chat/providers — list available AI providers */
chatRoutes.get("/providers", (c) => {
  try {
    return c.json(ok(providerRegistry.list()));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** GET /chat/sessions — list chat sessions filtered by project from context */
chatRoutes.get("/sessions", async (c) => {
  try {
    const projectPath = c.get("projectPath");
    const providerId = c.req.query("providerId");
    const sessions = await chatService.listSessions(providerId, projectPath);
    return c.json(ok(sessions));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** GET /chat/sessions/:id/messages — get message history */
chatRoutes.get("/sessions/:id/messages", async (c) => {
  try {
    const id = c.req.param("id");
    const providerId = c.req.query("providerId") ?? "claude-sdk";
    const messages = await chatService.getMessages(providerId, id);
    return c.json(ok(messages));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** POST /chat/sessions — create a new session for the project in context */
chatRoutes.post("/sessions", async (c) => {
  try {
    const projectName = c.get("projectName");
    const body = await c.req.json<{ providerId?: string; title?: string }>();
    const session = await chatService.createSession(body.providerId, {
      projectName,
      title: body.title,
    });
    return c.json(ok(session), 201);
  } catch (e) {
    return c.json(err((e as Error).message), 400);
  }
});

/** DELETE /chat/sessions/:id — delete a session */
chatRoutes.delete("/sessions/:id", async (c) => {
  try {
    const id = c.req.param("id");
    const providerId = c.req.query("providerId") ?? "claude-sdk";
    await chatService.deleteSession(providerId, id);
    return c.json(ok({ deleted: id }));
  } catch (e) {
    return c.json(err((e as Error).message), 404);
  }
});
