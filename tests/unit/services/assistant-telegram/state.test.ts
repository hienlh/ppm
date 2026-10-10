import { describe, expect, it } from "bun:test";
import "../../../test-setup.ts";
import { setConfigValue } from "../../../../src/services/db.service.ts";
import { BRIDGE_STATE_ROW, BridgeStateStore, readBridgeState } from "../../../../src/services/assistant-telegram/assistant-telegram-state.ts";

describe("what the bridge remembers across a restart", () => {
  it("keeps the offset and the unfinished messages of each chat in one config row", () => {
    const store = new BridgeStateStore({ offset: 0, chats: {} });
    store.setOffset(41);
    store.add("100", "render", 7);
    store.add("100", "render", 7);
    store.add("100", "cards", 9);
    store.add("200", "render", 3);
    store.remove("200", "render", 3);
    expect(readBridgeState()).toEqual({ offset: 41, chats: { "100": { render: [7], cards: [9] } } });

    const after = new BridgeStateStore();
    expect(after.offset).toBe(41);
    expect(after.takeAll()).toEqual({ "100": { render: [7], cards: [9] } });
    expect(readBridgeState().chats).toEqual({});
  });

  it("forgets a disconnected chat", () => {
    const store = new BridgeStateStore({ offset: 0, chats: {} });
    store.add("300", "cards", 1);
    store.forgetChat("300");
    expect(readBridgeState().chats["300"]).toBeUndefined();
  });

  it("sets aside what another bot left when the token changed", () => {
    new BridgeStateStore({ botId: "111", offset: 900, chats: { "5": { render: [3], cards: [] } } }).setOffset(901);
    expect(readBridgeState("111")).toEqual({ botId: "111", offset: 901, chats: { "5": { render: [3], cards: [] } } });
    // The new bot's update ids start far below 901: carrying the offset over would lose them.
    expect(readBridgeState("222")).toEqual({ botId: "222", offset: 0, chats: {} });
  });

  it("starts empty from a row it did not write", () => {
    setConfigValue(BRIDGE_STATE_ROW, "{not json");
    expect(readBridgeState()).toEqual({ offset: 0, chats: {} });
    setConfigValue(BRIDGE_STATE_ROW, JSON.stringify({ offset: -5, chats: { "x": { render: [1] }, "12": { render: ["a", 2, -1], cards: null } } }));
    expect(readBridgeState()).toEqual({ offset: 0, chats: { "12": { render: [2], cards: [] } } });
  });
});
