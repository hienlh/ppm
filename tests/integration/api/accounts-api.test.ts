import { describe, it, expect, beforeAll, beforeEach } from "bun:test";
import "../../test-setup.ts";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { setKeyPath } from "../../../src/lib/account-crypto.ts";
import { openTestDb, setDb, closeDb } from "../../../src/services/db.service.ts";
import { accountService } from "../../../src/services/account.service.ts";
import { accountSelector } from "../../../src/services/account-selector.service.ts";
import { app } from "../../../src/server/index.ts";

const testKeyPath = resolve(tmpdir(), `ppm-test-api-${Date.now()}.key`);
setKeyPath(testKeyPath);

beforeAll(() => {
  setDb(openTestDb());
});

beforeEach(() => {
  // Clear all accounts between tests via fresh DB
  setDb(openTestDb());
  // Reset strategy
  accountSelector.setStrategy("round-robin");
  accountSelector.setMaxRetry(0);
});

async function req(path: string, init?: RequestInit) {
  const url = `http://localhost${path}`;
  const headers = new Headers(init?.headers);
  if (!headers.has("Content-Type") && init?.body) {
    headers.set("Content-Type", "application/json");
  }
  return app.request(new Request(url, { ...init, headers }));
}

describe("GET /api/accounts", () => {
  it("returns empty array initially", async () => {
    const res = await req("/api/accounts");
    const json = await res.json() as any;
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.data).toEqual([]);
  });

  it("returns accounts after adding one", async () => {
    accountService.add({ email: "test@example.com", accessToken: "tok", refreshToken: "ref", expiresAt: 9999 });
    const res = await req("/api/accounts");
    const json = await res.json() as any;
    expect(json.data).toHaveLength(1);
    expect(json.data[0].email).toBe("test@example.com");
    // Tokens must not be exposed
    expect(json.data[0].accessToken).toBeUndefined();
    expect(json.data[0].refreshToken).toBeUndefined();
  });
});

describe("DELETE /api/accounts/:id", () => {
  it("removes account successfully", async () => {
    const acc = accountService.add({ email: "del@test.com", accessToken: "t", refreshToken: "r", expiresAt: 0 });
    const res = await req(`/api/accounts/${acc.id}`, { method: "DELETE" });
    const json = await res.json() as any;
    expect(json.ok).toBe(true);
    expect(json.data.deleted).toBe(true);
    expect(accountService.list()).toHaveLength(0);
  });
});

describe("PATCH /api/accounts/:id", () => {
  it("disables account", async () => {
    const acc = accountService.add({ email: "patch@test.com", accessToken: "t", refreshToken: "r", expiresAt: 0 });
    const res = await req(`/api/accounts/${acc.id}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "disabled" }),
    });
    const json = await res.json() as any;
    expect(json.ok).toBe(true);
    expect(json.data.status).toBe("disabled");
  });

  it("re-enables account", async () => {
    const acc = accountService.add({ email: "patch@test.com", accessToken: "t", refreshToken: "r", expiresAt: 0 });
    accountService.setDisabled(acc.id);
    const res = await req(`/api/accounts/${acc.id}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "active" }),
    });
    const json = await res.json() as any;
    expect(json.data.status).toBe("active");
  });

  it("returns 400 for invalid status", async () => {
    const acc = accountService.add({ email: "x@test.com", accessToken: "t", refreshToken: "r", expiresAt: 0 });
    const res = await req(`/api/accounts/${acc.id}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "invalid" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/accounts/settings", () => {
  it("returns default settings", async () => {
    const res = await req("/api/accounts/settings");
    const json = await res.json() as any;
    expect(json.ok).toBe(true);
    expect(json.data.strategy).toBe("round-robin");
    expect(json.data.maxRetry).toBe(0);
    expect(typeof json.data.activeCount).toBe("number");
  });
});

describe("PUT /api/accounts/settings", () => {
  it("updates strategy to fill-first", async () => {
    const res = await req("/api/accounts/settings", {
      method: "PUT",
      body: JSON.stringify({ strategy: "fill-first" }),
    });
    const json = await res.json() as any;
    expect(json.ok).toBe(true);
    expect(json.data.strategy).toBe("fill-first");
  });

  it("updates maxRetry", async () => {
    const res = await req("/api/accounts/settings", {
      method: "PUT",
      body: JSON.stringify({ maxRetry: 3 }),
    });
    const json = await res.json() as any;
    expect(json.data.maxRetry).toBe(3);
  });

  it("returns 400 for invalid strategy", async () => {
    const res = await req("/api/accounts/settings", {
      method: "PUT",
      body: JSON.stringify({ strategy: "random" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 for negative maxRetry", async () => {
    const res = await req("/api/accounts/settings", {
      method: "PUT",
      body: JSON.stringify({ maxRetry: -1 }),
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/accounts/oauth/start", () => {
  it("redirects to claude.ai OAuth URL", async () => {
    const res = await req("/api/accounts/oauth/start");
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("claude.ai/oauth/authorize");
    expect(location).toContain("code_challenge=");
    expect(location).toContain("state=");
  });
});

describe("GET /api/accounts/oauth/callback", () => {
  it("redirects with error when error param present", async () => {
    const res = await req("/api/accounts/oauth/callback?error=access_denied");
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("error=access_denied");
  });

  it("redirects with error when code missing", async () => {
    const res = await req("/api/accounts/oauth/callback?state=abc");
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("error=");
  });

  it("redirects with error for invalid state", async () => {
    const res = await req("/api/accounts/oauth/callback?code=abc&state=invalid-state");
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("error=");
  });
});

describe("GET /api/accounts/export", () => {
  it("returns JSON download with no accounts", async () => {
    const res = await req("/api/accounts/export");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = await res.text();
    expect(JSON.parse(body)).toEqual([]);
  });

  it("exports accounts as encrypted JSON", async () => {
    accountService.add({ email: "exp@test.com", accessToken: "tok", refreshToken: "ref", expiresAt: 9999 });
    const res = await req("/api/accounts/export");
    const rows = await res.json() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].email).toBe("exp@test.com");
    // Tokens are stored encrypted — not plaintext
    expect(rows[0].access_token).not.toBe("tok");
  });
});
