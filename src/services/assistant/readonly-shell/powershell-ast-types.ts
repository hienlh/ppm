/**
 * The PowerShell AST as the parser helper serializes it (`powershell-ast-helper-script.ts`).
 * Every node is `{ t: <.NET type name>, <property>: <value>, ... }` with the .NET property names
 * kept, so the judge reads `n.Left`, `n.CommandElements` and so on exactly as PowerShell's own
 * documentation names them. Values that are not nodes carry a `$k` marker.
 *
 * Nothing here trusts the shape: every accessor returns `undefined` for a value of the wrong
 * kind, and the judge asks whenever it gets `undefined` where it needed something.
 */

export interface PsTypeName { $k: "type"; FullName: string }

export interface PsVariablePath {
  $k: "var";
  UserPath: string;
  DriveName: string | null;
  IsDriveQualified: boolean;
  IsUnqualified: boolean;
  IsUnscopedVariable: boolean;
  IsVariable: boolean;
  IsGlobal: boolean;
  IsScript: boolean;
  IsLocal: boolean;
  IsPrivate: boolean;
}

/** A node already written elsewhere in the same tree (`ConvertExpressionAst.Attribute`). */
export interface PsRef { $k: "ref" }

/** A property value of a .NET type the helper does not serialize (`ScriptRequirements`…). */
export interface PsOther { $k: "other"; type: string }

export type PsValue = null | string | boolean | PsNode | PsTypeName | PsVariablePath | PsRef | PsOther | PsValue[];

export interface PsNode {
  t: string;
  [property: string]: PsValue | undefined;
}

/** One reply from the helper. */
export type PsParseReply =
  | { ok: true; count: number; ast: PsNode; psVersion: string }
  | { ok: false; error: string };

export function isNode(v: PsValue | undefined): v is PsNode {
  return typeof v === "object" && v !== null && !Array.isArray(v) && typeof (v as PsNode).t === "string";
}

/** The property `key` of `n` when it is a node, optionally of type `type`. */
export function child(n: PsNode, key: string, type?: string): PsNode | undefined {
  const v = n[key];
  return isNode(v) && (type === undefined || v.t === type) ? v : undefined;
}

/** The property `key` of `n` as a list; `null` reads as empty, anything else as undefined. */
export function list(n: PsNode, key: string): PsValue[] | undefined {
  const v = n[key];
  if (v === null) return [];
  return Array.isArray(v) ? v : undefined;
}

export function str(n: PsNode, key: string): string | undefined {
  const v = n[key];
  return typeof v === "string" ? v : undefined;
}

export function bool(n: PsNode, key: string): boolean | undefined {
  const v = n[key];
  return typeof v === "boolean" ? v : undefined;
}

export function typeName(n: PsNode, key: string): string | undefined {
  const v = n[key];
  return typeof v === "object" && v !== null && !Array.isArray(v) && (v as PsTypeName).$k === "type" && typeof (v as PsTypeName).FullName === "string"
    ? (v as PsTypeName).FullName
    : undefined;
}

export function variablePath(n: PsNode): PsVariablePath | undefined {
  const v = n.VariablePath;
  return typeof v === "object" && v !== null && !Array.isArray(v) && (v as PsVariablePath).$k === "var" && typeof (v as PsVariablePath).UserPath === "string"
    ? (v as PsVariablePath)
    : undefined;
}

/** A string or number written out literally, with nothing expanded inside it. */
export function isConstant(n: PsNode | undefined): boolean {
  return n?.t === "StringConstantExpressionAst" || n?.t === "ConstantExpressionAst";
}

/** The literal strings and numbers a value is written as, or undefined when any part is computed. */
export function literalTexts(value: PsNode): string[] | undefined {
  const items = value.t === "ArrayLiteralAst" ? list(value, "Elements") ?? [null] : [value];
  const texts = items.map((e) => (isNode(e) && isConstant(e) ? str(e, "Value") : undefined));
  return texts.every((t): t is string => t !== undefined) ? texts : undefined;
}

/** The one bare expression a statement holds (`@{ LogName = 'System' }`'s value), or undefined. */
export function soleExpression(statement: PsValue | undefined): PsNode | undefined {
  if (!isNode(statement) || statement.t !== "PipelineAst") return undefined;
  const elements = list(statement, "PipelineElements");
  const first = elements?.length === 1 ? elements[0] : undefined;
  if (!isNode(first) || first.t !== "CommandExpressionAst" || !isEmpty(first.Redirections)) return undefined;
  return child(first, "Expression");
}

/** A property that must be absent in an allowed construct: null, missing, false or an empty list. */
export function isEmpty(v: PsValue | undefined): boolean {
  return v === undefined || v === null || v === false || (Array.isArray(v) && v.length === 0);
}

/**
 * How many nodes the tree holds, and whether it carries any value the helper could not
 * serialize. A count that differs from the helper's own `FindAll` count means a subtree was lost
 * between the two, so the caller treats the tree as unreadable.
 */
export function inspectTree(root: PsValue): { nodes: number; refs: string[]; others: string[] } {
  const out = { nodes: 0, refs: [] as string[], others: [] as string[] };
  const walk = (v: PsValue | undefined, owner: string, key: string): void => {
    if (Array.isArray(v)) {
      for (const item of v) walk(item, owner, key);
      return;
    }
    if (typeof v !== "object" || v === null) return;
    if (isNode(v)) {
      out.nodes++;
      for (const [k, value] of Object.entries(v)) if (k !== "t") walk(value, v.t, k);
      return;
    }
    const kind = (v as { $k?: unknown }).$k;
    if (kind === "ref") out.refs.push(`${owner}.${key}`);
    else if (kind === "other") out.others.push(`${owner}.${key}`);
  };
  walk(root, "", "");
  return out;
}
