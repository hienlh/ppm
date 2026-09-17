/**
 * Which running servers `/lsp/status` reports as this project's.
 *
 * The indicator in the editor draws the server's name and its `ready` state from this list,
 * so a neighbour's server appearing in it says a project has a language server when it does
 * not — the one thing the status endpoint exists to answer honestly.
 */
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { isWithinProject } from "../../../src/server/routes/lsp.ts";

const p = (...parts: string[]) => parts.join(sep);

describe("isWithinProject", () => {
  it("accepts the project root itself", () => {
    // A server rooted at the project is the common case: `rootMarkers` usually match there.
    expect(isWithinProject(p("", "srv", "app"), p("", "srv", "app"))).toBe(true);
  });

  it("accepts a server rooted inside the project", () => {
    // A monorepo package with its own tsconfig gets its own root.
    expect(isWithinProject(p("", "srv", "app", "packages", "web"), p("", "srv", "app"))).toBe(true);
  });

  it("rejects a sibling whose name starts the same way", () => {
    // The bug: a bare `startsWith` matched every server rooted in `/srv/app2`, `/srv/app-old`
    // and `/srv/apples` as belonging to `/srv/app`.
    expect(isWithinProject(p("", "srv", "app2"), p("", "srv", "app"))).toBe(false);
    expect(isWithinProject(p("", "srv", "app-old", "src"), p("", "srv", "app"))).toBe(false);
  });

  it("rejects a parent of the project", () => {
    expect(isWithinProject(p("", "srv"), p("", "srv", "app"))).toBe(false);
  });

  it("does not double the separator when the project path already ends in one", () => {
    expect(isWithinProject(p("", "srv", "app", "src"), p("", "srv", "app", ""))).toBe(true);
    expect(isWithinProject(p("", "srv", "app2"), p("", "srv", "app", ""))).toBe(false);
  });

  it("is what the status route filters with", () => {
    const src = readFileSync(resolve(import.meta.dir, "../../../src/server/routes/lsp.ts"), "utf8");
    expect(src).toContain("isWithinProject(entry.rootPath, projectPath)");
    expect(src).not.toMatch(/rootPath\.startsWith\(projectPath\)/);
  });
});
