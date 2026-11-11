/**
 * Old cards that no longer wait are removed, so the table every Telegram reply is matched against
 * stays bounded; a card still waiting, or one with news the Assistant has not been told, is kept
 * whatever its age.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { getDb } from "../../../src/services/db.service.ts";
import { CARD_RETENTION_MS, getCardRow, insertCardRow, pruneOldCardRows } from "../../../src/services/assistant-cards/assistant-cards-db.ts";

const NOW = Date.UTC(2026, 10, 11);
const old = NOW - CARD_RETENTION_MS - 1;
const card = (status: "open" | "answered" | "info", at: number, wake: "none" | "pending" = "none") => insertCardRow({
  kind: status === "info" ? "rules_note" : "done", projectKey: null, sessionId: null, title: "t", body: "", payload: {}, status, wake, at,
}).id;

beforeEach(() => { getDb().run("DELETE FROM assistant_cards"); });

describe("card retention", () => {
  it("removes old cards that stopped waiting and keeps the rest", () => {
    const gone = [card("answered", old), card("info", old)];
    const kept = [card("open", old), card("answered", old, "pending"), card("answered", NOW)];
    expect(pruneOldCardRows(NOW - CARD_RETENTION_MS)).toBe(2);
    for (const id of gone) expect(getCardRow(id)).toBeNull();
    for (const id of kept) expect(getCardRow(id)).not.toBeNull();
  });
});
