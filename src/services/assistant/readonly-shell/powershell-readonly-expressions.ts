import { child, isConstant, isEmpty, isNode, list, str, typeName, variablePath, type PsNode, type PsValue } from "./powershell-ast-types.ts";
import { READABLE_AUTOMATIC, READABLE_ENV, firstRefusal, memberRefusal, type PsScope, type Refusal } from "./powershell-judge-scope.ts";
import { judgeStatement, judgeStatementBlock } from "./powershell-readonly-judge.ts";

/**
 * The expression half of the PowerShell judge: constants, strings, variables, members, types and
 * operators. Everything not listed asks — in particular a script block, which is only accepted
 * where a cmdlet runs it over its input (the command judge decides those positions).
 */

/** Types a script may name: plain values and `[math]`. Keys are lower-cased without `System.`. */
const ALLOWED_TYPES = new Set([
  "int", "int32", "long", "int64", "double", "decimal", "string", "bool", "boolean", "datetime", "timespan", "math",
  "pscustomobject", "management.automation.pscustomobject", "array", "hashtable", "collections.hashtable",
]);
const STATIC_METHODS: Readonly<Record<string, ReadonlySet<string>>> = {
  math: new Set(["min", "max", "round", "floor", "ceiling", "abs", "truncate"]),
  datetime: new Set(["parse"]),
};
const STATIC_PROPERTIES: Readonly<Record<string, ReadonlySet<string>>> = {
  datetime: new Set(["now", "utcnow"]),
};
/**
 * Methods a script may call on any object. The receiver's type is unknown when the script is
 * judged, so a name is listed only when nothing a read can produce gives it a side effect — which
 * is why `Replace` is not here: on a `FileInfo` from `Get-Item` it overwrites a file. The `-replace`
 * operator does the string's job.
 */
const INSTANCE_METHODS = new Set([
  "substring", "tostring", "touniversaltime", "tolocaltime", "tolower", "toupper", "trim", "trimstart", "trimend", "split",
  "contains", "startswith", "endswith", "indexof", "padleft", "padright", "addseconds", "addminutes", "addhours",
  "adddays", "gettype",
]);
const BINARY_OPERATORS = new Set([
  "Plus", "Minus", "Multiply", "Divide", "Rem", "DotDot", "Format", "And", "Or", "Xor", "Band", "Bor", "Bxor", "Shl", "Shr", "Join",
  ...["eq", "ne", "ge", "gt", "lt", "le", "like", "notlike", "match", "notmatch", "replace", "contains", "notcontains", "in", "notin", "split"]
    .flatMap((op) => [`I${op}`, `C${op}`]),
]);
/** `-is`, `-isnot` and `-as` resolve their right side as a type, which must then be an allowed one. */
const TYPE_OPERATORS = new Set(["Is", "IsNot", "As"]);
const UNARY_OPERATORS = new Set(["Not", "Exclaim", "Minus", "Plus", "Bnot", "Join", "Isplit", "Csplit"]);
const STEP_OPERATORS = new Set(["PlusPlus", "MinusMinus", "PostfixPlusPlus", "PostfixMinusMinus"]);

/** `System.Int32` → `int32`; an array of a type (`System.String[]`) is judged as the type. */
export function normalizeTypeName(fullName: string): string {
  return fullName.toLowerCase().replace(/^system\./, "").replace(/\[\]$/, "");
}

export function judgeTypeName(fullName: string | undefined): Refusal {
  if (!fullName) return "a type PPM cannot read";
  return ALLOWED_TYPES.has(normalizeTypeName(fullName)) ? null : `the type [${fullName}] is not one PPM knows to be harmless`;
}

/** A plain local variable as written on the left of `=` or after `foreach (`. */
export function localVariableName(n: PsNode | undefined): string | undefined {
  if (!n || n.t !== "VariableExpressionAst" || n.Splatted !== false) return undefined;
  const path = variablePath(n);
  return path && path.IsUnqualified && !path.IsDriveQualified ? path.UserPath : undefined;
}

function judgeVariableRead(n: PsNode, s: PsScope): Refusal {
  if (n.Splatted !== false) return "splatting passes parameters PPM cannot see";
  const path = variablePath(n);
  if (!path) return "a variable PPM cannot read";
  if (path.IsDriveQualified) {
    const [drive, name = ""] = path.UserPath.split(":", 2);
    if (drive?.toLowerCase() === "env" && READABLE_ENV.has(name.toLowerCase())) return null;
    return `reading $${path.UserPath} may reveal a secret`;
  }
  if (!path.IsUnqualified) return `$${path.UserPath} reaches outside the script's own variables`;
  const name = path.UserPath.toLowerCase();
  if (READABLE_AUTOMATIC.has(name) || s.locals.has(name)) return null;
  return `$${path.UserPath} is not a variable the script set`;
}

function judgeMember(n: PsNode, s: PsScope, invoked: boolean): Refusal {
  const member = child(n, "Member", "StringConstantExpressionAst");
  const name = member && str(member, "Value");
  if (!name) return "a member named by an expression PPM cannot read";
  const denied = memberRefusal(name);
  if (denied) return denied;
  if (!isEmpty(n.GenericTypeArguments)) return "a generic method call";
  const target = child(n, "Expression");
  if (!target) return "a member of something PPM cannot read";
  const lower = name.toLowerCase();
  if (n.Static === true) {
    const type = target.t === "TypeExpressionAst" ? typeName(target, "TypeName") : undefined;
    const key = type ? normalizeTypeName(type) : "";
    const allowed = (invoked ? STATIC_METHODS : STATIC_PROPERTIES)[key];
    return allowed?.has(lower) ? null : `[${type ?? "?"}]::${name} is not a static member PPM knows to only read`;
  }
  if (n.Static !== false) return "a member access PPM cannot read";
  if (invoked && !INSTANCE_METHODS.has(lower)) return `the method ${name}() is not one PPM knows to only read`;
  return judgeExpression(target, s);
}

function judgeConversionType(n: PsNode): Refusal {
  const constraint = child(n, "Type", "TypeConstraintAst");
  return judgeTypeName(constraint && typeName(constraint, "TypeName"));
}

function judgeBinary(n: PsNode, s: PsScope): Refusal {
  const op = str(n, "Operator") ?? "";
  const right = child(n, "Right");
  if (TYPE_OPERATORS.has(op)) {
    if (right?.t !== "TypeExpressionAst") return `-${op.toLowerCase()} with a type named by a string`;
    return judgeTypeName(typeName(right, "TypeName")) ?? judgeExpression(child(n, "Left"), s);
  }
  if (!BINARY_OPERATORS.has(op)) return `the operator ${op} is not one PPM knows to only compute`;
  return judgeExpression(child(n, "Left"), s) ?? judgeExpression(right, s);
}

function judgeUnary(n: PsNode, s: PsScope): Refusal {
  const op = str(n, "TokenKind") ?? "";
  const operand = child(n, "Child");
  if (STEP_OPERATORS.has(op)) {
    const name = localVariableName(operand);
    return name && s.locals.has(name.toLowerCase()) ? null : "++ or -- on something other than the script's own variable";
  }
  return UNARY_OPERATORS.has(op) ? judgeExpression(operand, s) : `the operator ${op} is not one PPM knows to only compute`;
}

function judgeHashtable(n: PsNode, s: PsScope): Refusal {
  const pairs = list(n, "KeyValuePairs");
  if (!pairs) return "a hashtable PPM cannot read";
  for (const pair of pairs) {
    if (!Array.isArray(pair) || pair.length !== 2 || !isNode(pair[0]) || !isNode(pair[1])) return "a hashtable entry PPM cannot read";
    if (!isConstant(pair[0])) return "a hashtable key computed by an expression";
    const r = judgeStatement(pair[1], s);
    if (r) return r;
  }
  return null;
}

export function judgeExpressions(values: PsValue[] | undefined, s: PsScope): Refusal {
  if (!values) return "a list PPM cannot read";
  for (const v of values) {
    const r = judgeExpression(isNode(v) ? v : undefined, s);
    if (r) return r;
  }
  return null;
}

export function judgeExpression(n: PsNode | undefined, s: PsScope): Refusal {
  if (!n) return "an expression PPM cannot read";
  switch (n.t) {
    case "StringConstantExpressionAst":
    case "ConstantExpressionAst":
      return null;
    case "ExpandableStringExpressionAst":
      return judgeExpressions(list(n, "NestedExpressions"), s);
    case "VariableExpressionAst":
      return judgeVariableRead(n, s);
    case "MemberExpressionAst":
      return judgeMember(n, s, false);
    case "InvokeMemberExpressionAst":
      return firstRefusal(() => judgeMember(n, s, true), () => judgeExpressions(list(n, "Arguments"), s));
    case "TypeExpressionAst":
      return judgeTypeName(typeName(n, "TypeName"));
    case "ConvertExpressionAst":
      return firstRefusal(() => judgeConversionType(n), () => judgeExpression(child(n, "Child"), s));
    case "BinaryExpressionAst":
      return judgeBinary(n, s);
    case "UnaryExpressionAst":
      return judgeUnary(n, s);
    case "ParenExpressionAst":
      return judgeStatement(child(n, "Pipeline"), s);
    case "SubExpressionAst":
    case "ArrayExpressionAst":
      return judgeStatementBlock(child(n, "SubExpression", "StatementBlockAst"), s);
    case "ArrayLiteralAst":
      return judgeExpressions(list(n, "Elements"), s);
    case "HashtableAst":
      return judgeHashtable(n, s);
    case "IndexExpressionAst":
      return judgeExpression(child(n, "Target"), s) ?? judgeExpression(child(n, "Index"), s);
    case "ScriptBlockExpressionAst":
      return "a script block outside the cmdlets that run one over their input";
    default:
      return `${n.t} is not syntax PPM judges`;
  }
}
