/**
 * Folder and file paths in a Telegram message become links into PPM's file browser
 * (`/files?path=…`) only once a sender has checked them: a refused or missing path, or one never
 * checked, stays text, and the HTML stays something Telegram accepts.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import "../../../test-setup.ts";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { markdownToTelegramHtml } from "../../../../src/services/telegram/telegram-html-format.ts";
import { pathLinkCache } from "../../../../src/services/telegram/telegram-path-link-cache.ts";
import { primeTelegramPathLinks, telegramPathCandidates } from "../../../../src/services/telegram/telegram-path-links.ts";
import { parseTelegramHtml } from "../../../helpers/fake-telegram-bot-api.ts";

let root: string;
let folder: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "ppm-tg-path-links-"));
  folder = join(root, "story-2026-11-19-london");
  mkdirSync(folder, { recursive: true });
});
afterAll(() => rmSync(root, { recursive: true, force: true }));
beforeEach(() => pathLinkCache.clear());

describe("Telegram path links", () => {
  it("takes the absolute paths of prose and code spans, never relative ones or URLs", () => {
    const md = `Saved to \`${folder}\` and ${join(root, "x.txt")}; see src/app.ts and https://a.dev/b/c`;
    expect(telegramPathCandidates(md)).toEqual([folder, join(root, "x.txt")]);
  });

  it("links a checked folder and leaves a missing one as text", async () => {
    const missing = join(root, "nope");
    const md = `Open \`${folder}\` or ${missing} now`;
    await primeTelegramPathLinks(md);
    const html = markdownToTelegramHtml(md);
    expect(html).toContain(`/files?path=${encodeURIComponent(folder)}`);
    expect(html).not.toContain(encodeURIComponent(missing));
    expect(html).toContain(missing.replace(/&/g, "&amp;"));
    const parsed = parseTelegramHtml(html);
    expect("error" in parsed).toBe(false);
  });

  it("links nothing that was never checked", () => {
    expect(markdownToTelegramHtml(`Open \`${folder}\``)).toBe(`Open <code>${folder}</code>`);
  });
});
