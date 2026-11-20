/**
 * The composer's voice message rides in the chat draft beside the typed text: stored by
 * `PUT /chat/drafts/:id` only in the shape PPM writes, read back by `GET`, cleared by `voice: null`,
 * and left alone by a bundle from before voice drafts, which sends no `voice` key at all.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import "../test-setup.ts"; // disable auth
import { configService } from "../../src/services/config.service.ts";
import { app } from "../../src/server/index.ts";
import { getDb, openTestDb, setDb } from "../../src/services/db.service.ts";
import { VOICE_DRAFT_MAX_TEXT } from "../../src/shared/voice-draft.ts";

const PROJECT = "test";
const PATH = "/home/u/.ppm/uploads/1a2b3c4d-voice-20261120T100000.webm";
const VOICE = {
  path: PATH,
  durationSec: 42,
  transcript: {
    text: "sửa Hono middleware, edited", shown: "sửa Hono middleware", raw: "sửa hono mid lơ wear",
    cleaned: true, transcribeMs: 2100, cleanupMs: 900,
    timings: { browserConvertMs: 120, requestMs: 3400, transcribeMs: 2100, cleanupMs: 900, cleaned: true },
  },
};

let n = 0;
const sessionId = () => `voice-draft-${Date.now()}-${++n}`;

async function req(path: string, init?: RequestInit) {
  const headers = new Headers(init?.headers);
  headers.set("Content-Type", "application/json");
  return app.request(new Request(`http://localhost/api/project/${PROJECT}${path}`, { ...init, headers }));
}
const put = (id: string, body: unknown) => req(`/chat/drafts/${id}`, { method: "PUT", body: JSON.stringify(body) });
async function get(id: string) {
  const json = (await (await req(`/chat/drafts/${id}`)).json()) as { data: Record<string, unknown> | null };
  return json.data;
}

// The same setup as draft-routes.test.ts: an in-memory database and a project named "test".
beforeAll(() => {
  setDb(openTestDb());
  (configService as unknown as { config: { auth: unknown } }).config.auth = { enabled: false, token: "" };
  const projects = configService.get("projects");
  if (!projects.find((p) => p.name === PROJECT)) configService.set("projects", [...projects, { name: PROJECT, path: process.cwd() }]);
});

describe("voice in the chat draft", () => {
  it("the migration gives chat_drafts a voice column", () => {
    const columns = getDb().query("PRAGMA table_info(chat_drafts)").all() as { name: string }[];
    expect(columns.map((c) => c.name)).toContain("voice");
  });

  it("stores a voice and reads it back with the text and attachments", async () => {
    const id = sessionId();
    expect((await put(id, { content: "typed", attachments: "[]", voice: VOICE })).status).toBe(200);
    const draft = await get(id);
    expect(draft?.content).toBe("typed");
    expect(draft?.attachments).toBe("[]");
    expect(draft?.voice).toEqual(VOICE);
  });

  it("a draft saved without a voice reads as before, with voice null", async () => {
    const id = sessionId();
    await put(id, { content: "only text", attachments: "[]", voice: null });
    expect(await get(id)).toMatchObject({ content: "only text", attachments: "[]", voice: null });
  });

  it("voice: null clears it; a PUT with no voice key (an older bundle) keeps it", async () => {
    const id = sessionId();
    await put(id, { content: "a", voice: VOICE });
    await put(id, { content: "edited on an older bundle", attachments: "[]" });
    expect(await get(id)).toMatchObject({ content: "edited on an older bundle", voice: VOICE });
    await put(id, { content: "b", attachments: "[]", voice: null });
    expect((await get(id))?.voice).toBeNull();
  });

  it("refuses a path that is not a stored recording, and keeps the rest of the draft", async () => {
    const id = sessionId();
    await put(id, { content: "keep me", voice: { ...VOICE, path: "/etc/passwd" } });
    expect(await get(id)).toMatchObject({ content: "keep me", voice: null });
    const raw = getDb().query("SELECT voice FROM chat_drafts WHERE session_id = ?").get(id) as { voice: string | null };
    expect(raw.voice).toBeNull();
  });

  it("refuses a mistyped voice and stores nothing it was not told", async () => {
    const id = sessionId();
    await put(id, { content: "x", voice: { path: PATH, durationSec: "42" } });
    expect((await get(id))?.voice).toBeNull();
    await put(id, { content: "x", voice: { ...VOICE, injected: "<script>" } });
    expect((await get(id))?.voice).toEqual(VOICE);
  });

  it("cuts a transcript past the limit", async () => {
    const id = sessionId();
    await put(id, { content: "x", voice: { ...VOICE, transcript: { ...VOICE.transcript, text: "a".repeat(VOICE_DRAFT_MAX_TEXT + 10) } } });
    const voice = (await get(id))?.voice as typeof VOICE;
    expect(voice.transcript.text.length).toBe(VOICE_DRAFT_MAX_TEXT);
  });

  it("a voice written to the database by other means is checked again on the way out", async () => {
    const id = sessionId();
    await put(id, { content: "x", voice: null });
    getDb().query("UPDATE chat_drafts SET voice = ? WHERE session_id = ?").run(JSON.stringify({ path: "/etc/shadow", durationSec: 1 }), id);
    expect((await get(id))?.voice).toBeNull();
  });

  it("deleting the draft deletes the voice with it", async () => {
    const id = sessionId();
    await put(id, { content: "x", voice: VOICE });
    await req(`/chat/drafts/${id}`, { method: "DELETE" });
    expect(await get(id)).toBeNull();
  });
});
