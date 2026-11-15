/**
 * The transcript never draws a secure or sealed value: a locked `vault_read` result becomes a
 * count, under either provider's tool name and whether it arrived live or from history, and a
 * `vault_propose` call never shows the value the AI sent. Every value here is fake.
 */
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { installDom, uninstallDom, mount, click, type Mounted } from "../../helpers/react-dom";
import type { ChatEvent } from "../../../src/types/chat";

installDom();
afterAll(uninstallDom);
const { ToolCard } = await import("../../../src/web/components/chat/tool-cards");
const { lockedReadSummary, vaultToolCall, vaultCardInput } = await import("../../../src/web/lib/vault-tool-call");

const SECRET_A = "FAKE-AB123456C";
const SECRET_B = "FAKE-221B-STREET";
const lockedOutput = [
  "Vault items (secure tier). These came from the user's vault. Use them only for the purpose you gave.",
  `- NI number (NI number): ${SECRET_A}`,
  `- Home (Address): ${SECRET_B}`,
  "  note: fake note",
].join("\n");
const codexOutput = JSON.stringify([{ type: "text", text: lockedOutput }]);
const publicOutput = "Public vault items:\n- Shoe size (Other): 42";

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

const toolUse = (tool: string, input: unknown, toolUseId = "t1") => ({ type: "tool_use", tool, input, toolUseId }) as unknown as ChatEvent;
const toolResult = (output: string, isError = false) => ({ type: "tool_result", output, isError, toolUseId: "t1" }) as unknown as ChatEvent;

async function render(tool: string, input: unknown, output?: string, isError = false) {
  view = await mount(<ToolCard tool={toolUse(tool, input)} result={output === undefined ? undefined : toolResult(output, isError)} />);
  await click(view.container.querySelector("[data-vault-tool-card] button"));
  return view.container;
}

describe("lockedReadSummary", () => {
  it("counts the items of a locked read and leaves every other result alone", () => {
    expect(lockedReadSummary(lockedOutput)).toEqual({ count: 2 });
    expect(lockedReadSummary(codexOutput)).toEqual({ count: 2 });
    expect(lockedReadSummary(publicOutput)).toBeNull();
    expect(lockedReadSummary("The user declined.")).toBeNull();
  });

  it("still hides a locked read wrapped in a way it does not know", () => {
    expect(lockedReadSummary(JSON.stringify({ content: lockedOutput }))).toEqual({ count: 2 });
  });
});

describe("vault tool card", () => {
  for (const name of ["mcp__ppm-sessions__vault_read", "ppm_sessions:vault_read"]) {
    it(`draws a locked read under ${name} as a count, never its values`, async () => {
      const input = name.includes(":") ? { server: "ppm_sessions", tool: "vault_read", arguments: { items: ["a", "b"], purpose: "Tax form" } } : { items: ["a", "b"], purpose: "Tax form" };
      const root = await render(name, input, name.includes(":") ? codexOutput : lockedOutput);
      expect(root.querySelector("[data-vault-summary]")?.textContent).toBe("Read 2 vault items");
      expect(root.querySelector("[data-vault-details]")).not.toBeNull();
      expect(root.textContent).toContain("Tax form");
      expect(root.textContent).not.toContain(SECRET_A);
      expect(root.textContent).not.toContain(SECRET_B);
      expect(root.textContent).not.toContain("fake note");
    });
  }

  it("shows a public read as it is", async () => {
    const root = await render("mcp__ppm-sessions__vault_read", { items: ["p"], purpose: "Size" }, publicOutput);
    expect(root.textContent).toContain("Shoe size (Other): 42");
  });

  it("never shows the value a proposal carried", async () => {
    const input = { name: "Passport", kind: "passport", tier: "sealed", value: SECRET_A };
    expect(vaultToolCall("mcp__ppm-sessions__vault_propose", input)).toEqual({ tool: "vault_propose", name: "Passport", kind: "passport", tier: "sealed", hasValue: true });
    const root = await render("mcp__ppm-sessions__vault_propose", input, 'The user saved "Passport" to the sealed tier of the vault (id x).');
    expect(root.textContent).toContain("Passport");
    expect(root.textContent).toContain("Sealed");
    expect(root.textContent).not.toContain(SECRET_A);
  });
});

describe("vaultCardInput", () => {
  it("reads only ppm:vault cards, and drops a malformed sealed one", () => {
    expect(vaultCardInput("Bash", { kind: "read-sealed" })).toBeNull();
    expect(vaultCardInput("ppm:vault", { kind: "read-sealed", item: { id: 1 } })).toBeNull();
    expect(vaultCardInput("ppm:vault", { kind: "propose", name: "x", itemKind: "bogus", suggestedTier: "sealed", hasPrefill: true, enabled: { secure: true } }))
      .toMatchObject({ kind: "propose", itemKind: "other", enabled: { secure: true, sealed: false } });
  });
});
