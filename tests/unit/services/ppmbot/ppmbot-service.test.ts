import { describe, it, expect, beforeEach } from "bun:test";
import { openTestDb, setDb } from "../../../../src/services/db.service.ts";

/**
 * PPMBotService is a singleton that depends on configService, chatService,
 * and the Telegram API. We test the pure/stateless helpers and DB interactions.
 * Full integration requires a running server — covered by e2e tests.
 */

describe("PPMBot Service — DB pairing operations", () => {
  beforeEach(() => {
    const testDb = openTestDb();
    setDb(testDb);
  });

  it("should connect a chat in one step via DB helpers", async () => {
    const {
      upsertApprovedPairing,
      isPairedChat,
      listPairedChats,
    } = await import("../../../../src/services/db.service.ts");

    expect(isPairedChat("chat-100")).toBe(false);
    upsertApprovedPairing("chat-100", "user-200", "TestUser");
    expect(isPairedChat("chat-100")).toBe(true);

    // List
    const all = listPairedChats();
    expect(all.length).toBe(1);
    expect(all[0]!.status).toBe("approved");
  });

  it("should revoke pairing", async () => {
    const {
      upsertApprovedPairing,
      revokePairing,
      isPairedChat,
    } = await import("../../../../src/services/db.service.ts");

    upsertApprovedPairing("chat-200", "user-300", "TestUser2");
    expect(isPairedChat("chat-200")).toBe(true);

    revokePairing("chat-200");
    expect(isPairedChat("chat-200")).toBe(false);
  });
});

describe("PPMBot Service — message debounce constants", () => {
  it("should have CONTEXT_WINDOW_THRESHOLD at 80", async () => {
    // Read source to verify constant
    const source = await Bun.file(
      "src/services/ppmbot/ppmbot-service.ts",
    ).text();
    expect(source).toContain("const CONTEXT_WINDOW_THRESHOLD = 80");
  });
});
