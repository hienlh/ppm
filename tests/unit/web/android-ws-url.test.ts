import { describe, expect, test } from "bun:test";

// The URL carries the PPM token, which `withWsAuth` reads from localStorage — absent under
// bun:test, where merely calling it throws. Stubbed before the import so the module under test
// sees it, and with a token, because "no device in the url" has to be asserted against a URL
// that really has a query string on it.
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (key: string) => (key.includes("token") ? "test-token" : null),
  setItem: () => {}, removeItem: () => {}, clear: () => {}, key: () => null, length: 0,
} as Storage;

const { resolveAndroidWsUrl } = await import("../../../src/web/components/android/android-ws-url");

const lan = { protocol: "http:", hostname: "192.168.1.10", host: "192.168.1.10:8080" };
const secure = { protocol: "https:", hostname: "ppm.example.com", host: "ppm.example.com" };

describe("android ws url", () => {
  test("plain http keeps its port and uses ws:", () => {
    expect(resolveAndroidWsUrl(lan, false)).toContain("ws://192.168.1.10:8080/ws/android");
  });

  test("https upgrades to wss:", () => {
    expect(resolveAndroidWsUrl(secure, false)).toContain("wss://ppm.example.com/ws/android");
  });

  // Vite's dev proxy has unreliable WS upgrade handling, so dev talks to the API port directly.
  test("dev bypasses the vite proxy, and honours an alt-port dev stack", () => {
    expect(resolveAndroidWsUrl({ ...lan, host: "localhost:5173" }, true))
      .toContain("ws://192.168.1.10:8081/ws/android");
    expect(resolveAndroidWsUrl({ ...lan, host: "localhost:5173" }, true, "8082"))
      .toContain(":8082/ws/android");
  });

  test("an https dev stack does not take the bypass, which would downgrade to ws:", () => {
    expect(resolveAndroidWsUrl(secure, true)).toStartWith("wss://");
  });

  // The device is named by the nonce in the first WS message, never by the URL: a query string
  // lands in proxy and tunnel access logs and which VM a socket drives should not.
  test("no device ever appears in the url", () => {
    const url = resolveAndroidWsUrl(lan, false);
    expect(url).not.toContain("device");
    expect(url).not.toContain("avd");
  });
});
