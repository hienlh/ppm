import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import {
  _resetTelegramApiBaseWarningForTests,
  botFileUrl,
  botMethodUrl,
  DEFAULT_TELEGRAM_API_BASE,
  parseLoopbackApiBase,
  scrubToken,
  TELEGRAM_API_BASE_ENV,
  telegramApiBase,
} from "../../../../src/services/telegram/telegram-api-base.ts";

const TOKEN = `123456789:${"A".repeat(35)}`;
const saved = process.env[TELEGRAM_API_BASE_ENV];

beforeEach(() => {
  delete process.env[TELEGRAM_API_BASE_ENV];
  _resetTelegramApiBaseWarningForTests();
});
afterEach(() => {
  if (saved === undefined) delete process.env[TELEGRAM_API_BASE_ENV];
  else process.env[TELEGRAM_API_BASE_ENV] = saved;
});

describe("parseLoopbackApiBase", () => {
  it("accepts a loopback origin with a port", () => {
    expect(parseLoopbackApiBase("http://127.0.0.1:8123")).toBe("http://127.0.0.1:8123");
    expect(parseLoopbackApiBase("http://localhost:8123/")).toBe("http://localhost:8123");
    expect(parseLoopbackApiBase("https://[::1]:9443")).toBe("https://[::1]:9443");
    expect(parseLoopbackApiBase(" HTTP://LOCALHOST:1 ")).toBe("http://localhost:1");
  });

  it("refuses anything that could carry the token to another machine", () => {
    for (const raw of [
      "https://api.telegram.org",
      "http://example.com:8080",
      "http://127.0.0.1.evil.com:8080",
      "http://10.0.0.2:8080",
      "http://127.0.0.2:8080",
      "http://user:pw@127.0.0.1:8080",
      "http://127.0.0.1",
      "http://127.0.0.1:8080/proxy",
      "http://127.0.0.1:8080/?x=1",
      "ftp://127.0.0.1:21",
      "not a url",
      "",
    ]) {
      expect(parseLoopbackApiBase(raw)).toBeNull();
    }
  });
});

describe("telegramApiBase", () => {
  it("is the real API by default", () => {
    expect(telegramApiBase()).toBe(DEFAULT_TELEGRAM_API_BASE);
    expect(botMethodUrl(TOKEN, "getMe")).toBe(`https://api.telegram.org/bot${TOKEN}/getMe`);
    expect(botFileUrl(TOKEN, "photos/file_1.jpg")).toBe(`https://api.telegram.org/file/bot${TOKEN}/photos/file_1.jpg`);
  });

  it("follows a loopback override, read on every call", () => {
    process.env[TELEGRAM_API_BASE_ENV] = "http://127.0.0.1:4567";
    expect(botMethodUrl(TOKEN, "sendMessage")).toBe(`http://127.0.0.1:4567/bot${TOKEN}/sendMessage`);
    delete process.env[TELEGRAM_API_BASE_ENV];
    expect(telegramApiBase()).toBe(DEFAULT_TELEGRAM_API_BASE);
  });

  it("ignores a non-loopback override and warns once, without its value", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      process.env[TELEGRAM_API_BASE_ENV] = "https://secret-proxy.example.com:8443";
      expect(telegramApiBase()).toBe(DEFAULT_TELEGRAM_API_BASE);
      expect(telegramApiBase()).toBe(DEFAULT_TELEGRAM_API_BASE);
      expect(warn).toHaveBeenCalledTimes(1);
      const line = warn.mock.calls.flat().join(" ");
      expect(line).toContain(TELEGRAM_API_BASE_ENV);
      expect(line).not.toContain("secret-proxy");
    } finally {
      warn.mockRestore();
    }
  });
});

describe("scrubToken", () => {
  it("takes the token out of an error message", () => {
    const msg = `fetch failed: https://api.telegram.org/bot${TOKEN}/getMe`;
    expect(scrubToken(msg, TOKEN)).toBe("fetch failed: https://api.telegram.org/bot[REDACTED]/getMe");
    expect(scrubToken("plain", "")).toBe("plain");
  });
});
