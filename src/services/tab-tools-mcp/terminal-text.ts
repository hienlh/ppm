import { Terminal } from "@xterm/headless";

/**
 * A terminal's output as text, the way its screen shows it. The server keeps what a shell
 * printed as raw bytes (`terminalService`'s buffer); replaying them through xterm's own parser
 * — headless, the one the browser runs — applies every carriage return, cursor move and erase.
 * A progress bar is then its last state, and a line editor's redraws are the line the user
 * typed: stripping escapes instead keeps every suggestion zsh drew and erased on the way, and
 * those quote the shell's history (measured with zsh-autosuggestions: a stripped
 * `echo hello world` read back with pieces of two unrelated history entries spliced into it).
 */

export interface TerminalScreen {
  /** Oldest first. A row the terminal wrapped is joined back to the line it continues. */
  lines: string[];
  /** A full-screen program (an editor, `top`) has the screen: `lines` is that screen alone. */
  fullScreen: boolean;
}

/** More rows than the 1 MB buffer can fill at any usable width. */
const SCROLLBACK = 100_000;

const clamp = (n: number, min: number, max: number): number => Math.min(max, Math.max(min, Math.floor(n) || min));

/** Replays `raw` on a terminal of the PTY's size. Measured: 1 MB of colored log lines in ~35 ms. */
export async function renderTerminal(raw: string, cols: number, rows: number): Promise<TerminalScreen> {
  const term = new Terminal({ cols: clamp(cols, 20, 1000), rows: clamp(rows, 2, 500), scrollback: SCROLLBACK });
  try {
    await new Promise<void>((done) => term.write(raw, done));
    const buffer = term.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buffer.length; i++) {
      const line = buffer.getLine(i);
      if (!line) continue;
      // A row the next one continues runs to the edge: its trailing spaces are the line's own.
      const text = line.translateToString(!buffer.getLine(i + 1)?.isWrapped);
      if (line.isWrapped && lines.length > 0) lines[lines.length - 1] += text;
      else lines.push(text);
    }
    while (lines.length > 0 && !lines[lines.length - 1]!.trim()) lines.pop();
    return { lines, fullScreen: buffer.type === "alternate" };
  } finally {
    term.dispose();
  }
}
