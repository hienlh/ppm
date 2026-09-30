import { describe, expect, it } from "bun:test";
import { buildDesignSystemInitPrompt } from "../../../src/shared/design-system-init-prompt";

const DEFAULT_TARGET = { id: "default", label: "Default", root: ".", platform: "web" as const };

describe("buildDesignSystemInitPrompt for the default app", () => {
  const prompt = buildDesignSystemInitPrompt(DEFAULT_TARGET);

  it("asks for DESIGN.md and tokens.css at the legacy designs/ root", () => {
    expect(prompt).toContain("designs/DESIGN.md");
    expect(prompt).toContain("designs/tokens.css");
  });

  it("asks for the real compiled CSS and fonts under kit/, stack-agnostically", () => {
    expect(prompt).toMatch(/real, compiled CSS/);
    expect(prompt).toContain("designs/kit/app.css");
    expect(prompt).toContain("designs/kit/fonts/");
    expect(prompt).toMatch(/no CSS build step at all,\s+hand-assemble/);
  });

  it("asks for icons, a component map naming source files, and the showcase page", () => {
    expect(prompt).toContain("designs/kit/icons/<name>.svg");
    expect(prompt).toMatch(/## Screens and components/);
    expect(prompt).toMatch(/source file path/);
    expect(prompt).toContain("designs/system-default/index.html");
    expect(prompt).toContain('href="../systems/default/tokens.css"');
  });

  it("covers a CSS-in-JS stack and records which library component a recipe stands for", () => {
    expect(prompt).toMatch(/MUI, antd v5, styled-components, emotion/);
    expect(prompt).toMatch(/antd tokens/);
    expect(prompt).toMatch(/createTheme/);
    expect(prompt).toMatch(/antd `<Button type="primary">`/);
  });

  it("never reads .env contents and asks before a build that needs secrets", () => {
    expect(prompt).toMatch(/Never read `\.env\*` file contents/);
    expect(prompt).toMatch(/ask me before running one that needs secrets/);
  });

  it("never asks to change application source, and scopes writes to the app's own folders", () => {
    expect(prompt).toMatch(/Never\s+edit the app's own source or build output/);
    expect(prompt).toMatch(/do not modify any other file in the project/);
  });
});

describe("buildDesignSystemInitPrompt for a declared app", () => {
  const prompt = buildDesignSystemInitPrompt({ id: "payroll-fe", label: "Payroll", root: "payroll-fe", platform: "mobile" });

  it("targets the app's own systems folder and root", () => {
    expect(prompt).toContain("designs/systems/payroll-fe/DESIGN.md");
    expect(prompt).toContain("designs/systems/payroll-fe/tokens.css");
    expect(prompt).toContain("designs/systems/payroll-fe/kit/app.css");
    expect(prompt).toContain("`payroll-fe/`");
    expect(prompt).toContain("designs/system-payroll-fe/index.html");
  });

  it("adds mobile guidance for a mobile app", () => {
    expect(prompt).toMatch(/mobile \(React Native or similar\)/);
    expect(prompt).toMatch(/phone frame/);
  });
});
