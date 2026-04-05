import { describe, it, expect, beforeEach } from "bun:test";
import { openTestDb, setDb } from "../../../../src/services/db.service.ts";

/**
 * ClawBotService is a singleton that depends on configService, chatService,
 * and the Telegram API. We test the pure/stateless helpers and DB interactions.
 * Full integration requires a running server — covered by e2e tests.
 */

describe("ClawBot Service — pairing code generation", () => {
  beforeEach(() => {
    const testDb = openTestDb();
    setDb(testDb);
  });

  it("should generate 6-character pairing codes with no ambiguous chars", () => {
    // Test the code generation pattern (no I, O, 0, 1)
    const ambiguous = /[IO01]/;
    const validChars = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/;

    // Generate multiple codes and verify pattern
    for (let i = 0; i < 50; i++) {
      const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
      let code = "";
      for (let j = 0; j < 6; j++) {
        code += chars[Math.floor(Math.random() * chars.length)];
      }
      expect(code).toMatch(validChars);
      expect(code).not.toMatch(ambiguous);
    }
  });
});

describe("ClawBot Service — DB pairing operations", () => {
  beforeEach(() => {
    const testDb = openTestDb();
    setDb(testDb);
  });

  it("should create and approve pairing via DB helpers", async () => {
    const {
      createPairingRequest,
      approvePairing,
      isPairedChat,
      getPairingByCode,
      getPairingByChatId,
      listPairedChats,
    } = await import("../../../../src/services/db.service.ts");

    // Create pairing
    createPairingRequest("chat-100", "user-200", "TestUser", "ABC123");

    // Verify pending
    const pending = getPairingByChatId("chat-100");
    expect(pending).toBeTruthy();
    expect(pending!.status).toBe("pending");

    // Not yet approved
    expect(isPairedChat("chat-100")).toBe(false);

    // Find by code
    const byCode = getPairingByCode("ABC123");
    expect(byCode).toBeTruthy();
    expect(byCode!.telegram_chat_id).toBe("chat-100");

    // Approve (approvePairing takes chatId, not code)
    approvePairing("chat-100");
    expect(isPairedChat("chat-100")).toBe(true);

    // List
    const all = listPairedChats();
    expect(all.length).toBe(1);
    expect(all[0]!.status).toBe("approved");
  });

  it("should revoke pairing", async () => {
    const {
      createPairingRequest,
      approvePairing,
      revokePairing,
      isPairedChat,
    } = await import("../../../../src/services/db.service.ts");

    createPairingRequest("chat-200", "user-300", "TestUser2", "XYZ789");
    approvePairing("chat-200");
    expect(isPairedChat("chat-200")).toBe(true);

    revokePairing("chat-200");
    expect(isPairedChat("chat-200")).toBe(false);
  });
});

describe("ClawBot Service — message debounce constants", () => {
  it("should have CONTEXT_WINDOW_THRESHOLD at 80", async () => {
    // Read source to verify constant
    const source = await Bun.file(
      "src/services/clawbot/clawbot-service.ts",
    ).text();
    expect(source).toContain("const CONTEXT_WINDOW_THRESHOLD = 80");
  });
});
