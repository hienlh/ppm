/**
 * The notebook's Settings routes: a line added or edited there is the user's and verified,
 * "Mark as verified" clears only the flag, the caps answer 400 with the reason, an unknown or
 * malformed id 404, a body that is neither an edit nor a verify 400.
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { Hono } from "hono";
import { getDb } from "../../../src/services/db.service.ts";
import { assistantNotesRoutes } from "../../../src/server/routes/assistant-notes.ts";
import { assistantNotes } from "../../../src/services/assistant-notes/assistant-notes.service.ts";
import { NOTEBOOK_CAP_CHARS, NOTE_MAX_CHARS } from "../../../src/shared/assistant-limits.ts";

const app = new Hono();
app.route("/api/assistant", assistantNotesRoutes);

const call = async (method: string, path: string, body?: unknown) => {
  const res = await app.request(`/api/assistant${path}`, {
    method, headers: { "content-type": "application/json" },
    ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
  });
  return { status: res.status, json: await res.json() as { ok: boolean; data?: any; error?: string } };
};

beforeEach(() => { getDb().run("DELETE FROM assistant_notes"); });
afterAll(() => { getDb().run("DELETE FROM assistant_notes"); });

describe("/api/assistant/notes", () => {
  it("lists lines with the space they use and the caps", async () => {
    await call("POST", "/notes", { text: "deadline friday" });
    const list = await call("GET", "/notes");
    expect(list.json.data).toMatchObject({ used: 15, cap: NOTEBOOK_CAP_CHARS, noteMax: NOTE_MAX_CHARS });
    expect(list.json.data.notes).toEqual([expect.objectContaining({ text: "deadline friday", source: "user", unverified: false })]);
  });

  it("makes an edited Assistant line the user's and verified", async () => {
    const own = assistantNotes.add("from a report", { by: "assistant", unattended: true });
    if (!own.ok) throw new Error(own.error);
    const edited = await call("PATCH", `/notes/${own.note.id}`, { text: "checked" });
    expect(edited).toMatchObject({ status: 200, json: { data: { note: { text: "checked", source: "user", unverified: false } } } });
  });

  it("clears only the flag on Mark as verified", async () => {
    const own = assistantNotes.add("from a report", { by: "assistant", unattended: true });
    if (!own.ok) throw new Error(own.error);
    const verified = await call("PATCH", `/notes/${own.note.id}`, { verified: true });
    expect(verified.json.data.note).toMatchObject({ text: "from a report", source: "assistant", unverified: false });
  });

  it("deletes any line, the Assistant's included", async () => {
    const own = assistantNotes.add("mine", { by: "assistant", unattended: false });
    if (!own.ok) throw new Error(own.error);
    expect((await call("DELETE", `/notes/${own.note.id}`)).status).toBe(200);
    expect((await call("DELETE", `/notes/${own.note.id}`)).status).toBe(404);
  });

  it("refuses bad bodies, caps and ids", async () => {
    expect((await call("POST", "/notes", { text: "x".repeat(NOTE_MAX_CHARS + 1) })).status).toBe(400);
    expect((await call("POST", "/notes", { text: "  " })).json.error).toBe("A note needs some text.");
    expect((await call("POST", "/notes", "not json")).status).toBe(400);
    expect((await call("POST", "/notes", { text: 5 })).status).toBe(400);
    const line = (await call("POST", "/notes", { text: "a" })).json.data.note;
    expect((await call("PATCH", `/notes/${line.id}`, {})).status).toBe(400);
    expect((await call("PATCH", `/notes/${line.id}`, { text: "b", verified: true })).status).toBe(400);
    expect((await call("PATCH", `/notes/${line.id}`, { verified: false })).status).toBe(400);
    expect((await call("PATCH", "/notes/0", { text: "b" })).status).toBe(404);
    expect((await call("PATCH", "/notes/abc", { text: "b" })).status).toBe(404);
    expect((await call("DELETE", "/notes/999999")).status).toBe(404);
  });
});
