import { describe, it, expect, afterEach } from "bun:test";
import { isRemoteDesktopEnabled } from "../../../../src/services/remote-desktop/remote-desktop-flag.ts";

describe("isRemoteDesktopEnabled", () => {
  const original = process.env.REMOTE_DESKTOP_ENABLED;
  afterEach(() => {
    if (original === undefined) delete process.env.REMOTE_DESKTOP_ENABLED;
    else process.env.REMOTE_DESKTOP_ENABLED = original;
  });

  it("defaults to enabled when unset", () => {
    delete process.env.REMOTE_DESKTOP_ENABLED;
    expect(isRemoteDesktopEnabled()).toBe(true);
  });

  it("is disabled for '0' or 'false' (any casing / surrounding whitespace)", () => {
    process.env.REMOTE_DESKTOP_ENABLED = "0";
    expect(isRemoteDesktopEnabled()).toBe(false);
    process.env.REMOTE_DESKTOP_ENABLED = " False ";
    expect(isRemoteDesktopEnabled()).toBe(false);
  });

  it("stays enabled for '1', 'true' and unrelated values", () => {
    process.env.REMOTE_DESKTOP_ENABLED = "1";
    expect(isRemoteDesktopEnabled()).toBe(true);
    process.env.REMOTE_DESKTOP_ENABLED = "true";
    expect(isRemoteDesktopEnabled()).toBe(true);
    process.env.REMOTE_DESKTOP_ENABLED = "yes";
    expect(isRemoteDesktopEnabled()).toBe(true);
  });
});
