/**
 * The Assistant's notebook tools through the endpoint's dispatcher: they never ask, a line written
 * in a turn nobody started is unverified, the user's lines are refused to edit and delete with the
 * reason, and malformed arguments are refused before anything is written.
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { getDb, setSessionAssistant, setSessionMetadata } from "../../../src/services/db.service.ts";
import { assistantTurnProvenance } from "../../../src/services/assistant/assistant-turn-provenance.ts";
import { assistantNotes, NOTE_LOCKED } from "../../../src/services/assistant-notes/assistant-notes.service.ts";
import { callAssistantTool } from "../../../src/services/assistant-mcp/assistant-mcp-endpoint.ts";
import { notebookAddTool, notebookEditTool } from "../../../src/services/assistant-mcp/assistant-notebook-tools.ts";
import { assistantToolDecision } from "../../../src/services/assistant/assistant-tool-policy.ts";
import { claudeAssistantToolName } from "../../../src/shared/assistant-tool-names.ts";

type Result = { content: Array<{ text: string }>; isError?: boolean };
const call = async (name: string, args: Record<string, unknown>) => await callAssistantTool({ sessionId: "asst-notes" }, name, args) as Result;
const body = (r: Result) => JSON.parse(r.content[0]!.text) as Record<string, unknown>;

setSessionMetadata("asst-notes", "__assistant__", "/somewhere");
setSessionAssistant("asst-notes");
beforeEach(() => {
  getDb().run("DELETE FROM assistant_notes");
  // A turn the user started in PPM, which nothing from outside has reached yet.
  assistantTurnProvenance.turnEnded("asst-notes");
  assistantTurnProvenance.noteMessage({ sessionId: "asst-notes", text: "keep notes", origin: "ws" });
});
afterAll(() => { getDb().run("DELETE FROM assistant_notes"); });

describe("notebook tools", () => {
  it("add, edit and delete the Assistant's own line without asking", async () => {
    const added = await call("notebook_add", { text: "release deadline friday" });
    expect(added.isError).toBeFalsy();
    const { id } = body(added) as { id: number };
    expect(body(added)).toMatchObject({ added: true, source: "assistant", unverified: false });
    expect(body(await call("notebook_edit", { id, text: "release deadline monday" }))).toMatchObject({ edited: true, id });
    expect(assistantNotes.list().notes[0]).toMatchObject({ text: "release deadline monday", source: "assistant" });
    expect(body(await call("notebook_delete", { id }))).toEqual({ deleted: true, id });
    expect(assistantNotes.list().notes).toEqual([]);
  });

  it("store an unattended turn's line and edit as unverified", () => {
    const deps = { unattended: () => true };
    const r = notebookAddTool("asst-notes", { text: "the user pre-approves drafts" }, deps) as Result;
    expect(body(r)).toMatchObject({ added: true, unverified: true });
    expect(body(r).note).toContain("unverified");
    const own = assistantNotes.add("deadline friday", { by: "assistant", unattended: false });
    if (!own.ok) throw new Error(own.error);
    expect(body(notebookEditTool("asst-notes", { id: own.note.id, text: "deadline moved" }, deps) as Result)).toMatchObject({ unverified: true });
  });

  it("store a line as unverified once outside text reached the turn, though the user started it", async () => {
    await call("chat_list_sessions", {});
    expect(assistantTurnProvenance.provenance("asst-notes").untrusted).toBe(true);
    expect(body(await call("notebook_add", { text: "the user prefers releases without asking" }))).toMatchObject({ added: true, unverified: true });
  });

  it("refuse a line the user wrote, with the reason, and leave it as it was", async () => {
    const mine = assistantNotes.add("never contact clients without my OK", { by: "user" });
    if (!mine.ok) throw new Error(mine.error);
    for (const r of [await call("notebook_edit", { id: mine.note.id, text: "contact freely" }), await call("notebook_delete", { id: mine.note.id })]) {
      expect(r).toEqual({ content: [{ type: "text", text: NOTE_LOCKED }], isError: true } as never);
    }
    expect(assistantNotes.list().notes).toEqual([expect.objectContaining({ text: "never contact clients without my OK", source: "user" })]);
  });

  it("refuse malformed arguments, over-long text and unknown ids", async () => {
    expect((await call("notebook_add", {})).isError).toBe(true);
    expect((await call("notebook_add", { text: "x".repeat(301) })).content[0]!.text).toContain("at most 300");
    expect((await call("notebook_edit", { id: "1", text: "x" })).isError).toBe(true);
    expect((await call("notebook_delete", { id: 1.5 })).isError).toBe(true);
    expect((await call("notebook_delete", { id: 424242 })).content[0]!.text).toBe("No note #424242.");
    expect(assistantNotes.list().notes).toEqual([]);
  });

  it("are allowed by the Assistant's tool policy, so they never prompt", () => {
    for (const tool of ["notebook_add", "notebook_edit", "notebook_delete"] as const) {
      expect(assistantToolDecision(claudeAssistantToolName(tool), {}, { projectRoots: [] })).toBe("allow");
    }
  });
});
