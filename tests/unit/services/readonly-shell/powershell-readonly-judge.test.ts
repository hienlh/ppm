/**
 * The PowerShell read-only judge over trees PowerShell's own parser recorded, so it runs on any
 * platform. The live parser is exercised in `powershell-helper.windows.test.ts`.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import "../../../test-setup.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { judgePowerShellAst } from "../../../../src/services/assistant/readonly-shell/powershell-readonly-judge.ts";
import { classifyPowerShellCommand } from "../../../../src/services/assistant/readonly-shell/powershell-readonly-classifier.ts";
import { inspectTree, type PsNode, type PsParseReply, type PsValue } from "../../../../src/services/assistant/readonly-shell/powershell-ast-types.ts";
import { createCorpusFixture, type CorpusFixture } from "./adversarial-bash-corpus.ts";
import { POWERSHELL_CORPUS, TRACE_SCRIPTS, materialize, powerShellCorpusContext, type PsCorpusCase } from "./adversarial-powershell-corpus.ts";

const recorded = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "powershell-asts", "corpus.json"), "utf8")) as {
  psVersion: string;
  replies: Record<string, PsParseReply>;
};

let fx: CorpusFixture;

beforeAll(() => {
  fx = createCorpusFixture();
});

afterAll(() => {
  fx.cleanup();
});

/** Every string in the tree with the corpus placeholders replaced by the fixture's folders. */
function materializeTree<T extends PsValue>(v: T): T {
  if (typeof v === "string") return materialize(v, fx) as T;
  if (Array.isArray(v)) return v.map((x) => materializeTree(x)) as T;
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, materializeTree(x as PsValue)])) as T;
  return v;
}

function recordedReply(script: string): PsParseReply {
  const reply = recorded.replies[script];
  if (!reply) throw new Error(`no recorded tree for ${JSON.stringify(script)}; run bun scripts/record-powershell-ast-fixtures.ts`);
  return reply.ok ? { ...reply, ast: materializeTree(reply.ast) } : reply;
}

const judgeCase = (c: PsCorpusCase) => judgePowerShellAst(recordedReply(c.script), { ...powerShellCorpusContext(fx), ...c.ctx?.(fx) });

describe("adversarial corpus on recorded trees", () => {
  it("holds at least 70 cases, every one with the expected verdict", () => {
    expect(POWERSHELL_CORPUS.length).toBeGreaterThanOrEqual(70);
    const wrong = POWERSHELL_CORPUS.map((c) => ({ c, v: judgeCase(c) }))
      .filter(({ c, v }) => v.verdict !== c.expected)
      .map(({ c, v }) => `${JSON.stringify(c.script)} (${c.why}): expected ${c.expected}, got ${v.verdict} — ${v.reason}`);
    expect(wrong).toEqual([]);
  });

  it("runs the three memory scripts from a real session unasked", () => {
    for (const script of TRACE_SCRIPTS) expect(judgeCase({ script, expected: "readonly", why: "" }).verdict).toBe("readonly");
  });

  it("gives every verdict a reason", () => {
    for (const c of POWERSHELL_CORPUS) expect(judgeCase(c).reason.length).toBeGreaterThan(0);
  });
});

describe("a tree PPM cannot trust", () => {
  const readonlyScript = "Get-PSDrive -PSProvider FileSystem";
  const tree = () => structuredClone(recordedReply(readonlyScript)) as Extract<PsParseReply, { ok: true }>;
  const ctx = () => powerShellCorpusContext(fx);

  it("judges the untouched tree readonly", () => {
    expect(judgePowerShellAst(tree(), ctx()).verdict).toBe("readonly");
  });

  it("asks when a parse failed", () => {
    expect(judgePowerShellAst({ ok: false, error: "parse error: x" }, ctx()).verdict).toBe("ask");
  });

  it("asks when the node count does not match the parser's", () => {
    const reply = tree();
    expect(judgePowerShellAst({ ...reply, count: reply.count + 1 }, ctx()).verdict).toBe("ask");
  });

  it("asks when a property could not be serialized", () => {
    const reply = tree();
    reply.ast.ScriptRequirements = { $k: "other", type: "System.Management.Automation.Language.ScriptRequirements" };
    expect(judgePowerShellAst(reply, ctx()).verdict).toBe("ask");
  });

  it("asks when a node is repeated anywhere but a conversion's attribute", () => {
    const reply = tree();
    (reply.ast.EndBlock as PsNode).Statements = [{ $k: "ref" }];
    const verdict = judgePowerShellAst({ ...reply, count: inspectTree(reply.ast).nodes }, ctx());
    expect(verdict.verdict).toBe("ask");
    expect(verdict.reason).toContain("NamedBlockAst.Statements");
  });

  it("asks for a node type it does not know, even with a matching count", () => {
    const reply = tree();
    const pipeline = ((reply.ast.EndBlock as PsNode).Statements as PsNode[])[0]!;
    pipeline.t = "WhileStatementAst";
    expect(judgePowerShellAst(reply, ctx()).verdict).toBe("ask");
  });

  it("asks when a $env: path is not set in the given environment", () => {
    const c = POWERSHELL_CORPUS.find((x) => x.script.startsWith('Get-Content "$env:USERPROFILE'))!;
    const verdict = judgePowerShellAst(recordedReply(c.script), { ...powerShellCorpusContext(fx), ...c.ctx?.(fx), env: {} });
    expect(verdict.verdict).toBe("ask");
  });
});

describe("classifyPowerShellCommand", () => {
  const fromRecording = { parse: async (script: string) => recordedReply(script) };

  it("returns the judge's verdict for the parser's tree", async () => {
    expect((await classifyPowerShellCommand("Get-PSDrive -PSProvider FileSystem", powerShellCorpusContext(fx), { helper: fromRecording })).verdict).toBe("readonly");
    expect((await classifyPowerShellCommand("Start-Process notepad", powerShellCorpusContext(fx), { helper: fromRecording })).verdict).toBe("ask");
  });

  it("asks without parsing for text it will not hand to PowerShell", async () => {
    let parsed = 0;
    const counting = { parse: async (script: string) => { parsed++; return recordedReply(script); } };
    for (const script of ["", "   ", "a".repeat(9000), "Get-Date\u0000", "Get-Date\u001b[0m", "Get-Date '\ud800'"]) {
      expect((await classifyPowerShellCommand(script, powerShellCorpusContext(fx), { helper: counting })).verdict).toBe("ask");
    }
    expect(parsed).toBe(0);
  });

  it("asks, never throws, when the helper fails or throws", async () => {
    const failing = { parse: async () => ({ ok: false as const, error: "the PowerShell parser did not answer within 1500 ms" }) };
    const throwing = { parse: async (): Promise<PsParseReply> => { throw new Error("boom"); } };
    const malformed = { parse: async () => ({ ok: true, count: 1, ast: null }) as unknown as PsParseReply };
    for (const helper of [failing, throwing, malformed]) {
      expect((await classifyPowerShellCommand("Get-PSDrive -PSProvider FileSystem", powerShellCorpusContext(fx), { helper })).verdict).toBe("ask");
    }
  });
});
