/**
 * A new-chat tab asks for its Claude process ahead of the first message. The route reads
 * that message's picks the way the chat socket reads them — a spare is only used when the
 * two agree — and only the new-chat route's sessions may take the process.
 */
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { Hono } from "hono";
import { chatRoutes } from "../../../src/server/routes/chat.ts";
import { chatService } from "../../../src/services/chat.service.ts";
import { providerRegistry } from "../../../src/providers/registry.ts";
import { THINKING_ADAPTIVE } from "../../../src/providers/claude-agent-sdk-query-options.ts";

const app = new Hono<any>();
app.use("*", async (c, next) => {
  c.set("projectName", "proj");
  c.set("projectPath", "/tmp/proj");
  await next();
});
app.route("/", chatRoutes);

const post = (path: string, body: unknown) =>
  app.request(`http://localhost${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const restore: Array<{ mockRestore(): void }> = [];
afterEach(() => { for (const spy of restore.splice(0)) spy.mockRestore(); });

describe("POST /prewarm", () => {
  it("passes on the picks the first message will carry, as the chat socket reads them", async () => {
    const prewarm = spyOn(chatService, "prewarm").mockResolvedValue();
    restore.push(prewarm);
    const body = { providerId: "claude", accountId: "acc-1", permissionMode: "acceptEdits", model: "claude-opus-4-5", effort: "high" };

    expect((await post("/prewarm", { ...body, thinking: false })).status).toBe(202);
    expect(prewarm).toHaveBeenLastCalledWith("claude", {
      projectPath: "/tmp/proj",
      accountId: "acc-1",
      opts: { permissionMode: "acceptEdits", model: "claude-opus-4-5", effort: "high", thinkingBudget: 0 },
    });
    await post("/prewarm", { ...body, thinking: true });
    expect(prewarm.mock.lastCall?.[1].opts?.thinkingBudget).toBe(THINKING_ADAPTIVE);
  });

  it("drops what the socket would not accept rather than starting a process nothing will use", async () => {
    const prewarm = spyOn(chatService, "prewarm").mockResolvedValue();
    restore.push(prewarm);
    await post("/prewarm", { providerId: 1, accountId: 7, permissionMode: "yolo", model: 5, effort: "extra", thinking: "yes" });
    expect(prewarm).toHaveBeenLastCalledWith(undefined, { projectPath: "/tmp/proj", accountId: undefined, opts: {} });
  });

  it("answers at once, whatever becomes of the start", async () => {
    let finish = () => {};
    const prewarm = spyOn(chatService, "prewarm").mockReturnValue(new Promise<void>((_, reject) => {
      finish = () => reject(new Error("no CLI"));
    }));
    restore.push(prewarm);
    expect((await post("/prewarm", {})).status).toBe(202);
    finish();
  });
});

describe("POST /sessions", () => {
  function created() {
    const createSession = spyOn(chatService, "createSession").mockResolvedValue({
      id: crypto.randomUUID(), providerId: "claude", title: "New Chat", createdAt: new Date().toISOString(),
    } as any);
    restore.push(createSession);
    return createSession;
  }

  it("lets a new chat take the process started for it", async () => {
    const createSession = created();
    expect((await post("/sessions", { providerId: "claude" })).status).toBe(201);
    expect(createSession.mock.lastCall?.[1]).toMatchObject({ projectPath: "/tmp/proj", adoptWarmSpare: true });
  });

  it("keeps it from a design session, which spawns with instructions of its own", async () => {
    const createSession = created();
    const lookup = spyOn(providerRegistry, "get").mockReturnValue({ id: "claude", supportsDesignInstructions: true } as any);
    restore.push(lookup);
    expect((await post("/sessions", { providerId: "claude", designSlug: "landing" })).status).toBe(201);
    expect(createSession.mock.lastCall?.[1]).toMatchObject({ adoptWarmSpare: false });
  });
});
