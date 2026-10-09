/**
 * The id a chat tab sends with every socket it opens: minted once per tab and well formed, and
 * on the server only a well-formed id is kept, anything else counts as no id at all.
 */
import { describe, expect, it } from "bun:test";
import { chatClientIdFrom } from "../../../src/shared/chat-client-id";
import { getChatClientId } from "../../../src/web/lib/chat-client-id";

describe("chatClientIdFrom", () => {
  it.each([
    ["0b6c5a4e-1f2d-4c3b-9a8e-7d6c5b4a3f21", true],
    ["phone-tab-0001", true],
    ["short", false],
    ["x".repeat(65), false],
    ["has space-0001", false],
    ["semi;colon-0001", false],
    ["", false],
  ])("%s → kept: %s", (raw, kept) => {
    expect(chatClientIdFrom(raw)).toBe(kept ? raw : undefined);
  });

  it("treats a missing parameter as no id", () => {
    expect(chatClientIdFrom(null)).toBeUndefined();
    expect(chatClientIdFrom(undefined)).toBeUndefined();
  });
});

describe("getChatClientId", () => {
  it("mints a well-formed id once and keeps answering it", () => {
    const id = getChatClientId();
    expect(chatClientIdFrom(id)).toBe(id);
    expect(getChatClientId()).toBe(id);
  });
});
