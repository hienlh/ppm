/**
 * `POST /sessions/:id/side-question` — `/btw`. The question goes to the session's live Claude
 * process; no process is a 409 the composer can explain, and an empty or oversized question
 * never reaches it.
 */
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { Hono } from "hono";
import { chatRoutes } from "../../../src/server/routes/chat.ts";
import { providerRegistry } from "../../../src/providers/registry.ts";

const app = new Hono<any>();
app.use("*", async (c, next) => {
  c.set("projectName", "proj");
  c.set("projectPath", "/tmp/proj");
  await next();
});
app.route("/", chatRoutes);

const post = (body: unknown) =>
  app.request("http://localhost/sessions/s-side/side-question", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const claude = providerRegistry.get("claude") as unknown as { askSideQuestion: (...a: unknown[]) => Promise<unknown> };
const restore: Array<{ mockRestore(): void }> = [];
afterEach(() => { for (const spy of restore.splice(0)) spy.mockRestore(); });

describe("POST /sessions/:id/side-question", () => {
  it("answers from the live CLI", async () => {
    const ask = spyOn(claude, "askSideQuestion").mockResolvedValue({ live: true, response: "In src/a.ts." });
    restore.push(ask);
    const res = await post({ question: "  where is a?  " });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, data: { response: "In src/a.ts." } });
    expect(ask.mock.calls[0]!.slice(0, 2)).toEqual(["s-side", "where is a?"]);
  });

  it("is a 409 when the session has no Claude process", async () => {
    restore.push(spyOn(claude, "askSideQuestion").mockResolvedValue({ live: false }));
    const res = await post({ question: "x" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain("Send a message first");
  });

  it("refuses an empty or oversized question before asking", async () => {
    const ask = spyOn(claude, "askSideQuestion");
    restore.push(ask);
    expect((await post({ question: "   " })).status).toBe(400);
    expect((await post({ question: "x".repeat(8_001) })).status).toBe(400);
    expect((await post({})).status).toBe(400);
    expect(ask).not.toHaveBeenCalled();
  });
});
