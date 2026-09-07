import { describe, it, expect, afterEach } from "bun:test";
import { isRemoteDesktopEnabled } from "../../../../src/services/remote-desktop/remote-desktop-flag.ts";

describe("isRemoteDesktopEnabled", () => {
  const original = process.env.REMOTE_DESKTOP_ENABLED;
  afterEach(() => {
    if (original === undefined) delete process.env.REMOTE_DESKTOP_ENABLED;
    else process.env.REMOTE_DESKTOP_ENABLED = original;
  });

  it("defaults to disabled when unset", () => {
    delete process.env.REMOTE_DESKTOP_ENABLED;
    expect(isRemoteDesktopEnabled()).toBe(false);
  });

  it("is disabled for any value other than '1'/'true'", () => {
    process.env.REMOTE_DESKTOP_ENABLED = "yes";
    expect(isRemoteDesktopEnabled()).toBe(false);
  });

  it("is enabled for '1' or 'true'", () => {
    process.env.REMOTE_DESKTOP_ENABLED = "1";
    expect(isRemoteDesktopEnabled()).toBe(true);
    process.env.REMOTE_DESKTOP_ENABLED = "true";
    expect(isRemoteDesktopEnabled()).toBe(true);
  });
});
