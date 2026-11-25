/**
 * Which chat code blocks get Run / Run in terminal: tagged shell blocks always, and untagged
 * blocks only when every line starts like a command — an AI often writes a one-off command with
 * no tag, while code and config must not grow a Run button.
 */
import { describe, expect, it } from "bun:test";
import { isShellCodeBlock } from "../../../src/web/lib/shell-block-detect";

describe("isShellCodeBlock", () => {
  it("takes every block tagged as shell", () => {
    for (const lang of ["bash", "sh", "shell", "zsh", "console", "BASH"]) expect(isShellCodeBlock(lang, "anything at all")).toBe(true);
  });

  it("takes an untagged one-line command, like the one that asked for this", () => {
    expect(isShellCodeBlock(undefined, "grep '^MASTER_PASSWORD=' ~/Desktop/Nexus/nxsys-workspace/nxsys-backend-nx6620-review/.env")).toBe(true);
    expect(isShellCodeBlock("text", "git status\n")).toBe(true);
    expect(isShellCodeBlock(undefined, "$ bun test")).toBe(true);
  });

  it("takes prefixes, paths to programs, comments and continued lines", () => {
    expect(isShellCodeBlock(undefined, "sudo systemctl restart nginx")).toBe(true);
    expect(isShellCodeBlock(undefined, "PPM_HOME=$(mktemp -d) bun my-script.ts")).toBe(true);
    expect(isShellCodeBlock(undefined, "./scripts/test.sh image/update")).toBe(true);
    expect(isShellCodeBlock(undefined, "~/bin/tool --flag")).toBe(true);
    expect(isShellCodeBlock(undefined, "# check the port first\nss -ltn | grep 3210")).toBe(true);
    expect(isShellCodeBlock(undefined, "docker run --rm \\\n  -p 80:80 \\\n  nginx")).toBe(true);
    expect(isShellCodeBlock(undefined, "cat a.log |\n  sort")).toBe(true);
  });

  it("leaves code, config and prose alone", () => {
    expect(isShellCodeBlock(undefined, "const x = 1;\nconsole.log(x);")).toBe(false);
    expect(isShellCodeBlock("ts", "git status")).toBe(false);
    expect(isShellCodeBlock("json", "{\"a\": 1}")).toBe(false);
    expect(isShellCodeBlock(undefined, "MASTER_PASSWORD=secret\nPORT=8080")).toBe(false);
    expect(isShellCodeBlock(undefined, "The build failed because the cache was stale.")).toBe(false);
    expect(isShellCodeBlock(undefined, "git status\nthen look at the output")).toBe(false);
    expect(isShellCodeBlock(undefined, "")).toBe(false);
  });

  it("leaves a long untagged block alone", () => {
    expect(isShellCodeBlock(undefined, Array.from({ length: 9 }, () => "echo hi").join("\n"))).toBe(false);
  });
});
