import { child, inspectTree, isEmpty, isNode, list, str, type PsNode, type PsParseReply } from "./powershell-ast-types.ts";
import { judgeCommand, judgeRedirections } from "./powershell-command-judge.ts";
import { isAssignableLocal, type PsScope, type Refusal } from "./powershell-judge-scope.ts";
import { judgeExpression, localVariableName } from "./powershell-readonly-expressions.ts";
import type { ReadonlyShellContext } from "./readonly-path-check.ts";
import { ask, readonly, type ShellVerdict } from "./shell-verdict.ts";

/**
 * Whether a PowerShell script only reads, judged on the tree PowerShell's own parser built for
 * it (see `powershell-ast-helper.ts`). Pure: it reads the serialized tree and the file system
 * paths the script names, so it runs anywhere — including on recorded trees in CI.
 *
 * An allowlist from the top down: statements (pipelines, assignments to plain locals, if,
 * foreach, for, try, break/continue/return/exit/throw), then commands
 * (`powershell-command-judge.ts`), then expressions (`powershell-readonly-expressions.ts`).
 * Any node type, property or name not listed asks. No function, class, trap, `while`, `using`,
 * `param` or named block: a script that needs one is not a read-only one-off.
 */

/** The only places a node may be reached twice: a conversion's type is also its attribute. */
const ALLOWED_REFS = new Set(["ConvertExpressionAst.Attribute"]);

export function judgePowerShellAst(reply: PsParseReply, ctx: ReadonlyShellContext): ShellVerdict {
  if (!reply.ok) return ask(`PowerShell could not parse the script (${reply.error})`);
  const tree = inspectTree(reply.ast);
  if (tree.nodes !== reply.count) return ask("the parsed script was not received whole");
  if (tree.others.length > 0) return ask(`the script uses ${tree.others[0]}, which PPM does not judge`);
  const ref = tree.refs.find((r) => !ALLOWED_REFS.has(r));
  if (ref) return ask(`the script uses ${ref} in a way PPM does not judge`);
  const scope: PsScope = { ctx, platform: ctx.platform ?? process.platform, locals: new Set() };
  const refusal = judgeScriptBlock(reply.ast, scope);
  return refusal ? ask(refusal) : readonly("every statement of the script only reads");
}

/** A script block, the script's own or one a cmdlet runs: an unnamed body and nothing else. */
export function judgeScriptBlock(n: PsNode | undefined, s: PsScope): Refusal {
  if (!n || n.t !== "ScriptBlockAst") return "a script block PPM cannot read";
  for (const [key, value] of Object.entries(n)) {
    if (key !== "t" && key !== "EndBlock" && !isEmpty(value)) return `a script block with ${key}`;
  }
  const body = child(n, "EndBlock", "NamedBlockAst");
  if (!body) return "an empty script block";
  if (body.Unnamed !== true || !isEmpty(body.Traps)) return "a named block or a trap";
  return judgeStatements(body, s);
}

export function judgeStatementBlock(n: PsNode | undefined, s: PsScope): Refusal {
  if (!n || n.t !== "StatementBlockAst" || !isEmpty(n.Traps)) return "a block PPM cannot read";
  return judgeStatements(n, s);
}

function judgeStatements(n: PsNode, s: PsScope): Refusal {
  const statements = list(n, "Statements");
  if (!statements) return "statements PPM cannot read";
  for (const statement of statements) {
    const r = judgeStatement(isNode(statement) ? statement : undefined, s);
    if (r) return r;
  }
  return null;
}

function judgePipeline(n: PsNode, s: PsScope): Refusal {
  if (n.Background === true) return "a pipeline started in the background";
  const elements = list(n, "PipelineElements");
  if (!elements || elements.length === 0) return "an empty pipeline";
  const labels: string[] = [];
  for (const [i, element] of elements.entries()) {
    if (!isNode(element)) return "a pipeline element PPM cannot read";
    if (element.t === "CommandExpressionAst") {
      if (i > 0) return "an expression after |";
      const r = judgeRedirections(element) ?? judgeExpression(child(element, "Expression"), s);
      if (r) return r;
      labels.push("expression");
    } else if (element.t === "CommandAst") {
      const outcome = judgeCommand(element, labels, s);
      if (outcome.refusal) return outcome.refusal;
      labels.push(outcome.label);
    } else {
      return `${element.t} is not a command PPM judges`;
    }
  }
  return null;
}

function judgeAssignment(n: PsNode, s: PsScope): Refusal {
  const name = localVariableName(child(n, "Left"));
  if (!name || !isAssignableLocal(name)) return "an assignment to something other than a plain local variable";
  const op = str(n, "Operator");
  if (!op || !["Equals", "PlusEquals", "MinusEquals", "MultiplyEquals", "DivideEquals", "RemainderEquals"].includes(op)) return `the assignment operator ${op}`;
  const r = judgeStatement(child(n, "Right"), s);
  if (r) return r;
  s.locals.add(name.toLowerCase());
  return null;
}

function judgeIf(n: PsNode, s: PsScope): Refusal {
  const clauses = list(n, "Clauses");
  if (!clauses || clauses.length === 0) return "an if statement PPM cannot read";
  for (const clause of clauses) {
    if (!Array.isArray(clause) || clause.length !== 2 || !isNode(clause[0]) || !isNode(clause[1])) return "an if clause PPM cannot read";
    const r = judgeStatement(clause[0], s) ?? judgeStatementBlock(clause[1], s);
    if (r) return r;
  }
  return n.ElseClause === null ? null : judgeStatementBlock(child(n, "ElseClause"), s);
}

function judgeForEach(n: PsNode, s: PsScope): Refusal {
  if (str(n, "Flags") !== "None" || !isEmpty(n.ThrottleLimit)) return "a parallel foreach";
  const name = localVariableName(child(n, "Variable"));
  if (!name || !isAssignableLocal(name) || name.toLowerCase() === "null") return "a foreach over something other than a plain local variable";
  const r = judgeStatement(child(n, "Condition"), s);
  if (r) return r;
  s.locals.add(name.toLowerCase());
  return judgeStatementBlock(child(n, "Body"), s);
}

function judgeFor(n: PsNode, s: PsScope): Refusal {
  for (const key of ["Initializer", "Condition", "Iterator"]) {
    if (n[key] === null) continue;
    const r = judgeStatement(child(n, key), s);
    if (r) return r;
  }
  return judgeStatementBlock(child(n, "Body"), s);
}

function judgeTry(n: PsNode, s: PsScope): Refusal {
  const r = judgeStatementBlock(child(n, "Body"), s);
  if (r) return r;
  for (const clause of list(n, "CatchClauses") ?? [null]) {
    if (!isNode(clause) || clause.t !== "CatchClauseAst") return "a catch clause PPM cannot read";
    // A catch type is only matched against the error; it is never constructed or invoked.
    const types = list(clause, "CatchTypes") ?? [null];
    if (!types.every((t) => isNode(t) && t.t === "TypeConstraintAst")) return "a catch type PPM cannot read";
    const body = judgeStatementBlock(child(clause, "Body"), s);
    if (body) return body;
  }
  return n.Finally === null ? null : judgeStatementBlock(child(n, "Finally"), s);
}

/** Any statement: a pipeline and the control flow around pipelines. */
export function judgeStatement(n: PsNode | undefined, s: PsScope): Refusal {
  if (!n) return "a statement PPM cannot read";
  switch (n.t) {
    case "PipelineAst":
      return judgePipeline(n, s);
    case "CommandExpressionAst":
      return judgeRedirections(n) ?? judgeExpression(child(n, "Expression"), s);
    case "PipelineChainAst":
      if (n.Background === true) return "a pipeline chain started in the background";
      return judgeStatement(child(n, "LhsPipelineChain"), s) ?? judgeStatement(child(n, "RhsPipeline"), s);
    case "AssignmentStatementAst":
      return judgeAssignment(n, s);
    case "IfStatementAst":
      return judgeIf(n, s);
    case "ForEachStatementAst":
      return judgeForEach(n, s);
    case "ForStatementAst":
      return judgeFor(n, s);
    case "TryStatementAst":
      return judgeTry(n, s);
    case "BreakStatementAst":
    case "ContinueStatementAst":
      return n.Label === null || child(n, "Label", "StringConstantExpressionAst") ? null : "a loop label computed by an expression";
    case "ReturnStatementAst":
    case "ExitStatementAst":
    case "ThrowStatementAst":
      return n.Pipeline === null ? null : judgeStatement(child(n, "Pipeline"), s);
    default:
      return `${n.t} is not a statement PPM judges`;
  }
}
