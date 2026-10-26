import { describe, it, expect } from "bun:test";
import { ClientTimeZoneState } from "../../../packages/vscode-compat/src/client-timezone.ts";
import { createVscodeCompat } from "../../../packages/vscode-compat/src/index.ts";
import type { RpcClient } from "../../../packages/vscode-compat/src/types.ts";

const rpc: RpcClient = {
  async request<T>() { return undefined as T; },
  async requestWithTimeout<T>() { return undefined as T; },
  notify() {},
};

const api = (clientTimeZone?: ClientTimeZoneState) =>
  createVscodeCompat({ extensionId: "probe", extensionPath: "/x", storagePath: "/x/.storage", rpc, clientTimeZone });

describe("vscode.env.clientTimeZone", () => {
  it("is undefined until a browser reports, then the last reported zone, shared by every extension", () => {
    const state = new ClientTimeZoneState();
    const a = api(state);
    const b = api(state);
    expect(a.env.clientTimeZone).toBeUndefined();
    state.report({ timeZone: "Europe/London", deviceId: "dev-1-aaaa" });
    expect(a.env.clientTimeZone).toBe("Europe/London");
    expect(b.env.clientTimeZone).toBe("Europe/London");
  });

  it("fires onDidChangeClientTimeZone only when the zone differs from the previous one", () => {
    const state = new ClientTimeZoneState();
    const seen: Array<{ timeZone: string; deviceId: string }> = [];
    const sub = api(state).env.onDidChangeClientTimeZone((e) => seen.push(e));
    state.report({ timeZone: "Europe/London", deviceId: "phone-0001" });
    state.report({ timeZone: "Europe/London", deviceId: "laptop-0002" });
    state.report({ timeZone: "Asia/Saigon", deviceId: "laptop-0002" });
    expect(seen).toEqual([
      { timeZone: "Europe/London", deviceId: "phone-0001" },
      { timeZone: "Asia/Saigon", deviceId: "laptop-0002" },
    ]);
    sub.dispose();
    state.report({ timeZone: "Europe/London", deviceId: "phone-0001" });
    expect(seen).toHaveLength(2);
  });

  it("without a source, stays undefined and its event never fires", () => {
    const env = api().env;
    expect(env.clientTimeZone).toBeUndefined();
    expect(typeof env.onDidChangeClientTimeZone(() => {}).dispose).toBe("function");
  });
});
