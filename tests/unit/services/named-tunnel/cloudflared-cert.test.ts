import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { readOriginCertState, getOriginCertPath } from "../../../../src/services/named-tunnel/cloudflared-cert.ts";

// Synthetic fixture only — never the real ~/.cloudflared/cert.pem on this host.
const FAKE_ZONE_ID = "a".repeat(32);
const FAKE_ACCOUNT_ID = "b".repeat(32);
const FAKE_API_TOKEN = "fake-token-not-a-real-secret";

function pemWithPayload(payload: unknown, label = "ARGO TUNNEL TOKEN"): string {
  const b64 = Buffer.from(JSON.stringify(payload)).toString("base64");
  return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----\n`;
}

describe("cloudflared-cert", () => {
  let dir: string;

  beforeAll(() => { dir = mkdtempSync(resolve(tmpdir(), "ppm-cert-")); });
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  function writeCert(content: string): string {
    const path = resolve(dir, `cert-${Math.random().toString(36).slice(2)}.pem`);
    writeFileSync(path, content);
    return path;
  }

  test("absent when file does not exist", () => {
    const state = readOriginCertState(resolve(dir, "does-not-exist.pem"));
    expect(state.kind).toBe("absent");
  });

  test("parsed for a valid cert (the real cert.pem shape)", () => {
    const path = writeCert(pemWithPayload({ zoneID: FAKE_ZONE_ID, accountID: FAKE_ACCOUNT_ID, apiToken: FAKE_API_TOKEN }));
    const state = readOriginCertState(path);
    expect(state.kind).toBe("parsed");
    if (state.kind === "parsed") {
      expect(state.cert).toEqual({ zoneID: FAKE_ZONE_ID, accountID: FAKE_ACCOUNT_ID, apiToken: FAKE_API_TOKEN });
    }
  });

  test("unparseable when the TOKEN block is missing entirely", () => {
    const path = writeCert("just some random file content, no PEM block\n");
    const state = readOriginCertState(path);
    expect(state.kind).toBe("unparseable");
  });

  test("unparseable when base64 is invalid", () => {
    const path = writeCert("-----BEGIN ARGO TUNNEL TOKEN-----\n!!!not-base64!!!\n-----END ARGO TUNNEL TOKEN-----\n");
    const state = readOriginCertState(path);
    expect(state.kind).toBe("unparseable");
  });

  test("unparseable when a required field is missing", () => {
    const path = writeCert(pemWithPayload({ zoneID: FAKE_ZONE_ID, accountID: FAKE_ACCOUNT_ID }));
    const state = readOriginCertState(path);
    expect(state.kind).toBe("unparseable");
  });

  test("unparseable when zoneID/accountID are not 32-char hex", () => {
    const path = writeCert(pemWithPayload({ zoneID: "not-hex", accountID: FAKE_ACCOUNT_ID, apiToken: FAKE_API_TOKEN }));
    const state = readOriginCertState(path);
    expect(state.kind).toBe("unparseable");
  });

  test("unparseable reason never contains the base64 payload or apiToken", () => {
    const payload = { zoneID: FAKE_ZONE_ID, accountID: FAKE_ACCOUNT_ID, apiToken: FAKE_API_TOKEN };
    const b64 = Buffer.from(JSON.stringify(payload)).toString("base64");
    const path = writeCert(`-----BEGIN ARGO TUNNEL TOKEN-----\n${b64.slice(0, -5)}\n-----END ARGO TUNNEL TOKEN-----\n`);
    const state = readOriginCertState(path);
    expect(state.kind).toBe("unparseable");
    if (state.kind === "unparseable") {
      expect(state.reason).not.toContain(FAKE_API_TOKEN);
      expect(state.reason).not.toContain(b64);
    }
  });

  test("getOriginCertPath honours TUNNEL_ORIGIN_CERT override", () => {
    const prev = process.env.TUNNEL_ORIGIN_CERT;
    process.env.TUNNEL_ORIGIN_CERT = resolve(dir, "custom-cert.pem");
    try {
      expect(getOriginCertPath()).toBe(resolve(dir, "custom-cert.pem"));
    } finally {
      if (prev === undefined) delete process.env.TUNNEL_ORIGIN_CERT;
      else process.env.TUNNEL_ORIGIN_CERT = prev;
    }
  });
});
