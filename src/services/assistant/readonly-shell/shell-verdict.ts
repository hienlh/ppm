/**
 * What the PPM Assistant's read-only command check answers for one shell command: `readonly`
 * means PPM can show from the text and the filesystem that the command only reads what the
 * Assistant may read unasked; `ask` means anything else, including "PPM could not tell".
 * The reason is a short English sentence for the session trace and logs, never a card.
 */
export type ShellVerdict =
  | { verdict: "readonly"; reason: string }
  | { verdict: "ask"; reason: string };

export function ask(reason: string): ShellVerdict {
  return { verdict: "ask", reason };
}

export function readonly(reason = "every part of the command only reads"): ShellVerdict {
  return { verdict: "readonly", reason };
}

export function isAsk(v: ShellVerdict): v is { verdict: "ask"; reason: string } {
  return v.verdict === "ask";
}
