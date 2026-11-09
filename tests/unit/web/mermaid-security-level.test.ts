/**
 * A Mermaid diagram is text the AI (or a reviewer it echoes) wrote. `securityLevel: "loose"`
 * keeps `click … href "javascript:…"` links live in the rendered SVG, which a real click runs on
 * PPM's origin (reproduced in Chromium). PPM wires no Mermaid click handlers, so "strict" costs
 * nothing. This guards the one initialise call from drifting back to "loose".
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = readFileSync(resolve(import.meta.dir, "../../../src/web/components/shared/markdown-code-block.tsx"), "utf8");

describe("mermaid is initialised in strict security mode", () => {
  it("passes securityLevel: \"strict\" and never \"loose\"", () => {
    const init = source.match(/\.initialize\(\{[^}]*\}\)/);
    expect(init).not.toBeNull();
    expect(init![0]).toContain('securityLevel: "strict"');
    expect(source).not.toContain('securityLevel: "loose"');
  });
});
