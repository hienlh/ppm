import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  broadcastExtMsg,
  requestFromBrowser,
  getExtClientCount,
  extensionWebSocket,
} from "../../../src/server/ws/extensions.ts";
import type { ExtServerMsg } from "../../../src/types/extension-messages.ts";

describe("extensionWebSocket", () => {
  // Create a fake WebSocket for testing
  function createFakeWs() {
    const messages: string[] = [];
    return {
      data: { type: "ext" },
      send: (data: string) => {
        messages.push(data);
      },
      messages,
    };
  }

  beforeEach(() => {
    // Reset client count by closing any open clients
    // (This is a bit of a hack, but we're testing module state)
    // We'll test client addition/removal via the handlers
  });

  describe("getExtClientCount", () => {
    it("returns 0 initially", () => {
      expect(getExtClientCount()).toBe(0);
    });

    it("increases when client opens", () => {
      const ws = createFakeWs();
      extensionWebSocket.open(ws as any);
      expect(getExtClientCount()).toBe(1);
      extensionWebSocket.close(ws as any);
    });

    it("decreases when client closes", () => {
      const ws = createFakeWs();
      extensionWebSocket.open(ws as any);
      expect(getExtClientCount()).toBe(1);
      extensionWebSocket.close(ws as any);
      expect(getExtClientCount()).toBe(0);
    });

    it("tracks multiple clients", () => {
      const ws1 = createFakeWs();
      const ws2 = createFakeWs();
      const ws3 = createFakeWs();

      extensionWebSocket.open(ws1 as any);
      expect(getExtClientCount()).toBe(1);

      extensionWebSocket.open(ws2 as any);
      expect(getExtClientCount()).toBe(2);

      extensionWebSocket.open(ws3 as any);
      expect(getExtClientCount()).toBe(3);

      extensionWebSocket.close(ws1 as any);
      expect(getExtClientCount()).toBe(2);

      extensionWebSocket.close(ws2 as any);
      extensionWebSocket.close(ws3 as any);
      expect(getExtClientCount()).toBe(0);
    });
  });

  describe("broadcastExtMsg", () => {
    it("does not throw when no clients connected", () => {
      const msg: ExtServerMsg = {
        type: "statusbar:update",
        item: {
          id: "test",
          text: "Test",
          alignment: "left",
          priority: 0,
        },
      };
      expect(() => broadcastExtMsg(msg)).not.toThrow();
    });

    it("sends message to single connected client", () => {
      const ws = createFakeWs();
      extensionWebSocket.open(ws as any);

      const msg: ExtServerMsg = {
        type: "statusbar:update",
        item: {
          id: "test",
          text: "Hello",
          alignment: "left",
          priority: 0,
        },
      };
      broadcastExtMsg(msg);

      expect(ws.messages).toHaveLength(1);
      const sent = JSON.parse(ws.messages[0]);
      expect(sent.type).toBe("statusbar:update");
      expect(sent.item.text).toBe("Hello");

      extensionWebSocket.close(ws as any);
    });

    it("sends message to all connected clients", () => {
      const ws1 = createFakeWs();
      const ws2 = createFakeWs();
      const ws3 = createFakeWs();

      extensionWebSocket.open(ws1 as any);
      extensionWebSocket.open(ws2 as any);
      extensionWebSocket.open(ws3 as any);

      const msg: ExtServerMsg = {
        type: "notifications",
        id: "msg1",
        level: "info",
        message: "Test",
      } as any;

      broadcastExtMsg(msg);

      expect(ws1.messages).toHaveLength(1);
      expect(ws2.messages).toHaveLength(1);
      expect(ws3.messages).toHaveLength(1);

      extensionWebSocket.close(ws1 as any);
      extensionWebSocket.close(ws2 as any);
      extensionWebSocket.close(ws3 as any);
    });

    it("handles send errors gracefully", () => {
      const ws = {
        data: { type: "ext" },
        send: () => {
          throw new Error("Send failed");
        },
      };

      extensionWebSocket.open(ws as any);

      const msg: ExtServerMsg = {
        type: "statusbar:remove",
        itemId: "test",
      };

      expect(() => broadcastExtMsg(msg)).not.toThrow();

      extensionWebSocket.close(ws as any);
    });
  });

  describe("requestFromBrowser", () => {
    it("times out and returns undefined", async () => {
      const msg: ExtServerMsg = {
        type: "quickpick:show",
        requestId: "req1",
        items: [],
      };

      const result = await requestFromBrowser(msg, "req1", 50);
      expect(result).toBeUndefined();
    });

    it("resolves with quickpick response", async () => {
      const msg: ExtServerMsg = {
        type: "quickpick:show",
        requestId: "req2",
        items: [{ label: "Option A" }, { label: "Option B" }],
      };

      const promise = requestFromBrowser(msg, "req2", 1000);

      // Simulate browser responding after a short delay
      setTimeout(() => {
        extensionWebSocket.message(
          { data: { type: "ext" }, send: () => {} } as any,
          JSON.stringify({
            type: "quickpick:resolve",
            requestId: "req2",
            selected: [{ label: "Option A" }],
          }),
        );
      }, 50);

      const result = await promise;
      expect(result).toEqual([{ label: "Option A" }]);
    });

    it("resolves with inputbox response", async () => {
      const msg: ExtServerMsg = {
        type: "inputbox:show",
        requestId: "req3",
        options: { prompt: "Enter value:" },
      };

      const promise = requestFromBrowser(msg, "req3", 1000);

      setTimeout(() => {
        extensionWebSocket.message(
          { data: { type: "ext" }, send: () => {} } as any,
          JSON.stringify({
            type: "inputbox:resolve",
            requestId: "req3",
            value: "user input",
          }),
        );
      }, 50);

      const result = await promise;
      expect(result).toBe("user input");
    });

    it("resolves with notification action response", async () => {
      const msg: ExtServerMsg = {
        type: "notification",
        id: "notif1",
        level: "info",
        message: "Do something?",
        actions: ["Yes", "No"],
      };

      const promise = requestFromBrowser(msg, "notif1", 1000);

      setTimeout(() => {
        extensionWebSocket.message(
          { data: { type: "ext" }, send: () => {} } as any,
          JSON.stringify({
            type: "notification:action",
            id: "notif1",
            action: "Yes",
          }),
        );
      }, 50);

      const result = await promise;
      expect(result).toBe("Yes");
    });
  });

  describe("extensionWebSocket.message", () => {
    it("ignores invalid JSON gracefully", async () => {
      const ws = { data: { type: "ext" }, send: () => {} };
      expect(() =>
        extensionWebSocket.message(ws as any, "not json at all"),
      ).not.toThrow();
    });

    it("handles quickpick:resolve message", async () => {
      const msg: ExtServerMsg = {
        type: "quickpick:show",
        requestId: "req-quick",
        items: [{ label: "A" }],
      };

      const promise = requestFromBrowser(msg, "req-quick", 1000);

      const ws = { data: { type: "ext" }, send: () => {} };
      await extensionWebSocket.message(
        ws as any,
        JSON.stringify({
          type: "quickpick:resolve",
          requestId: "req-quick",
          selected: [{ label: "A" }],
        }),
      );

      const result = await promise;
      expect(result).toEqual([{ label: "A" }]);
    });

    it("handles inputbox:resolve message", async () => {
      const msg: ExtServerMsg = {
        type: "inputbox:show",
        requestId: "req-input",
        options: {},
      };

      const promise = requestFromBrowser(msg, "req-input", 1000);

      const ws = { data: { type: "ext" }, send: () => {} };
      await extensionWebSocket.message(
        ws as any,
        JSON.stringify({
          type: "inputbox:resolve",
          requestId: "req-input",
          value: "resolved value",
        }),
      );

      const result = await promise;
      expect(result).toBe("resolved value");
    });

    it("handles notification:action message", async () => {
      const msg: ExtServerMsg = {
        type: "notification",
        id: "notif-action",
        level: "warn",
        message: "Warning",
        actions: ["OK"],
      };

      const promise = requestFromBrowser(msg, "notif-action", 1000);

      const ws = { data: { type: "ext" }, send: () => {} };
      await extensionWebSocket.message(
        ws as any,
        JSON.stringify({
          type: "notification:action",
          id: "notif-action",
          action: "OK",
        }),
      );

      const result = await promise;
      expect(result).toBe("OK");
    });

    it("ignores resolves for unknown request IDs", async () => {
      const ws = { data: { type: "ext" }, send: () => {} };
      expect(() =>
        extensionWebSocket.message(
          ws as any,
          JSON.stringify({
            type: "quickpick:resolve",
            requestId: "unknown-req",
            selected: null,
          }),
        ),
      ).not.toThrow();
    });

    it("handles message as Buffer", async () => {
      const msg: ExtServerMsg = {
        type: "inputbox:show",
        requestId: "req-buffer",
        options: {},
      };

      const promise = requestFromBrowser(msg, "req-buffer", 1000);

      const ws = { data: { type: "ext" }, send: () => {} };
      const buffer = Buffer.from(
        JSON.stringify({
          type: "inputbox:resolve",
          requestId: "req-buffer",
          value: "buffer value",
        }),
      );

      await extensionWebSocket.message(ws as any, buffer);

      const result = await promise;
      expect(result).toBe("buffer value");
    });
  });

  describe("extensionWebSocket.open", () => {
    it("adds ws to clients set", () => {
      const ws = createFakeWs();
      expect(getExtClientCount()).toBe(0);
      extensionWebSocket.open(ws as any);
      expect(getExtClientCount()).toBe(1);
      extensionWebSocket.close(ws as any);
    });
  });

  describe("extensionWebSocket.close", () => {
    it("removes ws from clients set", () => {
      const ws = createFakeWs();
      extensionWebSocket.open(ws as any);
      expect(getExtClientCount()).toBe(1);
      extensionWebSocket.close(ws as any);
      expect(getExtClientCount()).toBe(0);
    });

    it("handles closing unknown socket gracefully", () => {
      const ws = createFakeWs();
      expect(() => extensionWebSocket.close(ws as any)).not.toThrow();
    });
  });
});
