/**
 * The delegate rule an older project is offered: found however the file's lines are wrapped, added
 * once, where the template has it — before the first rule of the opening section, never inside a
 * later section whose heading may change what a line under it means.
 */
import { describe, expect, it } from "bun:test";
import {
  hasManagerDelegateRule, MANAGER_DELEGATE_RULE, withManagerDelegateRule,
} from "../../../src/shared/manager-default-rules.ts";
import { DEFAULT_MANAGER_RULES_TEMPLATE } from "../../../src/services/assistant-managers/manager-rules-default-template.ts";

const OLD_TEMPLATE = DEFAULT_MANAGER_RULES_TEMPLATE.replace(`${MANAGER_DELEGATE_RULE}\n`, "");

describe("the delegate rule", () => {
  it("is in PPM's template, and the template without it is what an older project was seeded with", () => {
    expect(hasManagerDelegateRule(DEFAULT_MANAGER_RULES_TEMPLATE)).toBe(true);
    expect(OLD_TEMPLATE).not.toBe(DEFAULT_MANAGER_RULES_TEMPLATE);
    expect(hasManagerDelegateRule(OLD_TEMPLATE)).toBe(false);
  });

  it("is found rewrapped or reworded after its opening sentence", () => {
    expect(hasManagerDelegateRule("- Manage the work;\n  do not do it yourself. Children do it.\n")).toBe(true);
    expect(hasManagerDelegateRule("- manage THE work; do not do it yourself.")).toBe(true);
    expect(hasManagerDelegateRule("- Manage the work.\n")).toBe(false);
  });

  it("goes back where the template has it, in an older project's template", () => {
    expect(withManagerDelegateRule(OLD_TEMPLATE)).toBe(DEFAULT_MANAGER_RULES_TEMPLATE);
  });

  it("is added once: a file that has it comes back unchanged", () => {
    const once = withManagerDelegateRule(OLD_TEMPLATE);
    expect(withManagerDelegateRule(once)).toBe(once);
    expect(once.split("Manage the work; do not do it yourself.")).toHaveLength(2);
  });

  it("goes before the first rule of an untitled file", () => {
    expect(withManagerDelegateRule("- a\n- b\n")).toBe(`${MANAGER_DELEGATE_RULE}\n- a\n- b\n`);
  });

  it("never lands inside a later section: above its heading when no rule comes before it", () => {
    const rules = "# Manager rules\n\nIntro.\n## Allowed without asking\n- run tests\n";
    expect(withManagerDelegateRule(rules)).toBe(
      `# Manager rules\n\nIntro.\n\n${MANAGER_DELEGATE_RULE}\n\n## Allowed without asking\n- run tests\n`,
    );
  });

  it("is appended after prose with no rule, and is the whole file when the file is empty", () => {
    expect(withManagerDelegateRule("# Rules\nBe careful.")).toBe(`# Rules\nBe careful.\n\n${MANAGER_DELEGATE_RULE}\n`);
    expect(withManagerDelegateRule("")).toBe(`${MANAGER_DELEGATE_RULE}\n`);
    expect(withManagerDelegateRule("\n  \n")).toBe(`${MANAGER_DELEGATE_RULE}\n`);
  });
});
