import { describe, expect, it } from "bun:test";
import { buildDesignSystemInitPrompt } from "../../../src/shared/design-system-init-prompt";

describe("buildDesignSystemInitPrompt", () => {
  const prompt = buildDesignSystemInitPrompt();

  it("asks for DESIGN.md and tokens.css as before", () => {
    expect(prompt).toContain("designs/DESIGN.md");
    expect(prompt).toContain("designs/tokens.css");
  });

  it("asks for the real compiled CSS and fonts under kit/, stack-agnostically", () => {
    expect(prompt).toMatch(/real, compiled CSS/);
    expect(prompt).toContain("designs/kit/app.css");
    expect(prompt).toContain("designs/kit/fonts/");
    expect(prompt).toMatch(/Tailwind, CSS modules, a CSS-in-JS build, or a plain stylesheet/);
    expect(prompt).toMatch(/no CSS build step at all, hand-assemble/);
  });

  it("asks for icons and a component map naming source files", () => {
    expect(prompt).toContain("designs/kit/icons/<name>.svg");
    expect(prompt).toMatch(/## Screens and components/);
    expect(prompt).toMatch(/source file path/);
  });

  it("never asks to change application source, and scopes writes to designs/", () => {
    expect(prompt).toMatch(/Never edit the project's own source or build output/);
    expect(prompt).toMatch(/do not modify any other file in the project/);
  });
});
