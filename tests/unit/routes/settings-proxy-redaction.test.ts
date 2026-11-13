/**
 * The proxy's auth key spends the user's accounts, so `/api/settings/proxy` answers only its first
 * characters — on GET and on PUT — unless the caller asks with `?reveal=1`.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { Hono } from "hono";
import { openTestDb, setDb } from "../../../src/services/db.service.ts";
import { proxyService } from "../../../src/services/proxy.service.ts";
import { redactProxyKey, settingsProxyRoutes } from "../../../src/server/routes/settings-proxy.ts";

const app = new Hono().route("/api/settings", settingsProxyRoutes);
const KEY = "ppm-proxy-0123456789abcdef0123456789abcdef";

async function call(method: string, path: string, body?: unknown) {
  const res = await app.request(`/api/settings${path}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }),
  });
  return { status: res.status, text: await res.text() };
}

beforeEach(() => {
  setDb(openTestDb());
  proxyService.setEnabled(false);
  proxyService.setAuthKey(KEY);
});

describe("redactProxyKey", () => {
  it("keeps the first four characters of a key and marks the rest as cut", () => {
    expect(redactProxyKey(KEY)).toBe("ppm-…");
  });

  it("never keeps half or more of a short custom key", () => {
    expect(redactProxyKey("abcd")).toBe("ab…");
    expect(redactProxyKey("x")).toBe("…");
  });

  it("leaves no key as no key", () => {
    expect(redactProxyKey(null)).toBeNull();
    expect(redactProxyKey("")).toBe("");
  });
});

describe("/api/settings/proxy", () => {
  it("GET answers the key redacted, and nowhere in the body whole", async () => {
    const { status, text } = await call("GET", "/proxy");
    expect(status).toBe(200);
    expect(text).not.toContain(KEY);
    expect(JSON.parse(text).data).toMatchObject({ authKey: "ppm-…", authKeyRevealed: false });
  });

  it("GET with reveal=1 answers the whole key", async () => {
    const { text } = await call("GET", "/proxy?reveal=1");
    expect(JSON.parse(text).data).toMatchObject({ authKey: KEY, authKeyRevealed: true });
  });

  it("PUT answers redacted too, including a key it just generated", async () => {
    const enabled = await call("PUT", "/proxy", { enabled: true });
    expect(enabled.text).not.toContain(KEY);
    const generated = await call("PUT", "/proxy", { generateKey: true });
    const fresh = proxyService.getAuthKey()!;
    expect(fresh).not.toBe(KEY);
    expect(generated.text).not.toContain(fresh);
    expect(JSON.parse(generated.text).data.authKey).toBe("ppm-…");
  });

  it("PUT with reveal=1 answers the new key whole", async () => {
    const { text } = await call("PUT", "/proxy?reveal=1", { generateKey: true });
    expect(JSON.parse(text).data.authKey).toBe(proxyService.getAuthKey());
  });

  it("answers no key, and says it is not revealed, when none is set", async () => {
    proxyService.setAuthKey("");
    const { text } = await call("GET", "/proxy?reveal=1");
    expect(JSON.parse(text).data).toMatchObject({ authKey: null, authKeyRevealed: false });
  });

  it("refuses an enabled flag that is not a boolean", async () => {
    const { status } = await call("PUT", "/proxy", { enabled: "yes" });
    expect(status).toBe(400);
    expect(proxyService.isEnabled()).toBe(false);
  });
});
