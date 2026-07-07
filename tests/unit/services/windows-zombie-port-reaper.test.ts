import { describe, expect, test } from "bun:test";
import { isDebrisOrphan } from "../../../src/services/windows-zombie-port-reaper.ts";

describe("isDebrisOrphan", () => {
  test("matches agent-browser daemon", () => {
    expect(isDebrisOrphan(
      "agent-browser-win32-x64.exe",
      '"C:\\Users\\PC\\AppData\\Roaming\\npm\\node_modules\\agent-browser\\bin\\agent-browser-win32-x64.exe"',
    )).toBe(true);
  });

  test("matches headless chrome from agent-browser", () => {
    expect(isDebrisOrphan(
      "chrome.exe",
      '"C:\\Users\\PC\\.agent-browser\\browsers\\chrome-149\\chrome.exe" --headless=new --user-data-dir=C:\\Temp\\agent-browser-chrome-abc',
    )).toBe(true);
  });

  test("does NOT match real user chrome (no --headless)", () => {
    expect(isDebrisOrphan(
      "chrome.exe",
      '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --profile-directory=Default',
    )).toBe(false);
  });

  test("matches msys coreutils from bash tool", () => {
    expect(isDebrisOrphan("tail.exe", '"C:\\Program Files\\Git\\usr\\bin\\tail.exe" -2')).toBe(true);
  });

  test("matches claude SDK node child", () => {
    expect(isDebrisOrphan(
      "node.exe",
      "node C:\\Users\\PC\\.bun\\install\\global\\node_modules\\@anthropic-ai\\claude-agent-sdk\\cli.js",
    )).toBe(true);
  });

  test("never matches cloudflared even with agent-browser in args", () => {
    expect(isDebrisOrphan(
      "cloudflared.exe",
      "cloudflared tunnel --url http://127.0.0.1:3210 agent-browser",
    )).toBe(false);
  });

  test("does NOT match unrelated daemonized apps", () => {
    expect(isDebrisOrphan("slack.exe", '"C:\\Users\\PC\\AppData\\Local\\slack\\slack.exe"')).toBe(false);
    expect(isDebrisOrphan("OneDrive.exe", '"C:\\Program Files\\Microsoft OneDrive\\OneDrive.exe"')).toBe(false);
    expect(isDebrisOrphan("browser.exe", '"C:\\Users\\PC\\AppData\\Local\\Programs\\browser\\browser.exe"')).toBe(false);
  });

  test("does NOT match plain node without claude in cmdline", () => {
    expect(isDebrisOrphan("node.exe", "node C:\\projects\\my-app\\server.js")).toBe(false);
  });

  test("does NOT match bun server processes without claude", () => {
    expect(isDebrisOrphan(
      "bun.exe",
      "C:\\Users\\PC\\.bun\\bin\\bun.exe run src/server/index.ts __serve__ 3210",
    )).toBe(false);
  });
});
