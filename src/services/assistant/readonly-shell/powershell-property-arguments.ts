import { child, isConstant, isNode, list, soleExpression, str, type PsNode } from "./powershell-ast-types.ts";
import { memberRefusal, type PsScope, type Refusal } from "./powershell-judge-scope.ts";
import { judgeScriptBlock, judgeStatement } from "./powershell-readonly-judge.ts";

/**
 * The arguments that name what to read from each input object: property names, calculated
 * properties (`@{ n = 'MB'; e = { $_.WS / 1MB } }`) and the script blocks Where-Object,
 * ForEach-Object and friends run over their input. These are the only places a script block is
 * accepted, and its body is judged by the same rules as the script around it.
 */

/** A script block given to a cmdlet that runs it over its input. */
export function judgeScriptBlockArgument(n: PsNode, s: PsScope): Refusal {
  if (n.t !== "ScriptBlockExpressionAst") return "a value other than a script block";
  return judgeScriptBlock(child(n, "ScriptBlock", "ScriptBlockAst"), s);
}

/** A property name read from every input object: literal, no wildcard, not a secret-bearing member. */
function judgePropertyName(n: PsNode): Refusal {
  const name = n.t === "StringConstantExpressionAst" ? str(n, "Value") : undefined;
  if (!name) return "a property name PPM cannot read";
  // `*` selects every property, the secret-bearing ones included.
  if (/[*?[\]]/.test(name)) return `the property pattern ${name} may select members that reveal secrets`;
  return memberRefusal(name);
}

/**
 * PowerShell matches a calculated property's keys by prefix (`ex` is `expression`), so a key is
 * read as the expression whenever it could be one; the other recognised keys hold plain values.
 */
const VALUE_KEYS = ["name", "label", "width", "alignment", "formatstring", "ascending", "descending"];

function judgeCalculatedProperty(n: PsNode, s: PsScope): Refusal {
  for (const pair of list(n, "KeyValuePairs") ?? [null]) {
    if (!Array.isArray(pair) || pair.length !== 2 || !isNode(pair[0]) || !isConstant(pair[0])) return "a calculated property PPM cannot read";
    const key = (str(pair[0], "Value") ?? "").toLowerCase();
    if (key && "expression".startsWith(key)) {
      const expr = soleExpression(pair[1]);
      if (!expr) return "a calculated property's expression PPM cannot read";
      const r = expr.t === "ScriptBlockExpressionAst" ? judgeScriptBlockArgument(expr, s) : judgePropertyName(expr);
      if (r) return r;
    } else if (key && VALUE_KEYS.some((k) => k.startsWith(key))) {
      const r = isNode(pair[1]) ? judgeStatement(pair[1], s) : "a calculated property PPM cannot read";
      if (r) return r;
    } else {
      return `the calculated property key ${key || "?"} is not one PPM knows`;
    }
  }
  return null;
}

/** `-Property` and friends: one item or a list of names, calculated properties and script blocks. */
export function judgeProperties(n: PsNode, s: PsScope): Refusal {
  const items = n.t === "ArrayLiteralAst" ? list(n, "Elements") : [n];
  if (!items) return "a property list PPM cannot read";
  for (const item of items) {
    if (!isNode(item)) return "a property PPM cannot read";
    const r =
      item.t === "HashtableAst" ? judgeCalculatedProperty(item, s)
        : item.t === "ScriptBlockExpressionAst" ? judgeScriptBlockArgument(item, s)
          : judgePropertyName(item);
    if (r) return r;
  }
  return null;
}
