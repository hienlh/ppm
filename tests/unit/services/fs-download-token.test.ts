import { describe, it, expect } from "bun:test";
import {
  createDownloadToken,
  consumeDownloadToken,
} from "../../../src/services/download-token.service.ts";

describe("path-bound download tokens", () => {
  it("accepts the bound path once and rejects the replay", () => {
    const token = createDownloadToken("/tmp/report.pdf");
    expect(consumeDownloadToken(token, "/tmp/report.pdf")).toBe(true);
    expect(consumeDownloadToken(token, "/tmp/report.pdf")).toBe(false);
  });

  it("rejects a different path and keeps the token unusable for it", () => {
    const token = createDownloadToken("/tmp/report.pdf");
    expect(consumeDownloadToken(token, "/etc/shadow")).toBe(false);
  });

  it("gate check without a path does not spend the token", () => {
    const token = createDownloadToken("/tmp/report.pdf");
    expect(consumeDownloadToken(token)).toBe(true);
    expect(consumeDownloadToken(token)).toBe(true);
    expect(consumeDownloadToken(token, "/tmp/report.pdf")).toBe(true);
  });

  it("rejects an unknown token", () => {
    expect(consumeDownloadToken("nope", "/tmp/report.pdf")).toBe(false);
    expect(consumeDownloadToken("")).toBe(false);
  });
});

describe("legacy project-scoped tokens", () => {
  it("stay valid for multiple uses inside the TTL", () => {
    const token = createDownloadToken();
    expect(consumeDownloadToken(token)).toBe(true);
    expect(consumeDownloadToken(token)).toBe(true);
  });

  it("cannot be used on the path-bound door", () => {
    const token = createDownloadToken();
    expect(consumeDownloadToken(token, "/tmp/report.pdf")).toBe(false);
  });
});
