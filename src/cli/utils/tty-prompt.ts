/**
 * One line typed at the terminal, with the echo off for a password.
 *
 * Raw mode rather than `readline`: readline has no way to stop echoing what is typed, and the
 * usual workaround patches one of its private methods.
 */

/** A terminal on both ends: someone is there to answer. An AI's shell, a pipe or cron is not. */
export function canAskOnTerminal(): boolean {
  return !!process.stdin.isTTY && !!process.stdout.isTTY;
}

/**
 * Ask `question` and resolve what was typed, or null when it was cancelled with Ctrl+C or
 * Ctrl+D. `hidden` shows nothing of what is typed.
 */
export function askOnTerminal(question: string, options: { hidden?: boolean } = {}): Promise<string | null> {
  const { stdin, stdout } = process;
  return new Promise((resolve) => {
    let value = "";
    const wasRaw = stdin.isRaw;
    const finish = (answer: string | null) => {
      stdin.off("data", onData);
      stdin.setRawMode(wasRaw);
      stdin.pause();
      stdout.write("\n");
      resolve(answer);
    };
    const onData = (chunk: Buffer | string) => {
      for (const ch of String(chunk)) {
        if (ch === "\r" || ch === "\n") return finish(value);
        if (ch === "\u0003" || ch === "\u0004") return finish(null);
        if (ch === "\u007f" || ch === "\b") {
          if (!value) continue;
          value = [...value].slice(0, -1).join("");
          if (!options.hidden) stdout.write("\b \b");
          continue;
        }
        // Arrow keys and the rest of the control sequences are not part of an answer.
        if (ch < " ") continue;
        value += ch;
        if (!options.hidden) stdout.write(ch);
      }
    };
    stdout.write(question);
    stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    stdin.resume();
    stdin.on("data", onData);
  });
}
