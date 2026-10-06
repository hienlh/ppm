/**
 * The smallest size PPM gives a shell's terminal.
 *
 * xterm's FitAddon never proposes less than 2x1, and 2x1 is exactly what it proposes for a
 * container with no layout: a tab parked off-screen, or one in a project that is open but not
 * shown. That size is not harmless once it reaches the shell. zsh with a themed prompt corrupts
 * its own heap redrawing that prompt at 2 columns, and aborts with "double free or corruption"
 * on the first keystroke after the tab is shown again, which can be an hour later and at a
 * perfectly ordinary size (measured: hidden at 2x1, every shell died on that keystroke; at
 * 3x1, 10x1, 2x20, 156x1 or larger, none did).
 *
 * No terminal anyone can use is this small, so the browser never fits below the floor and the
 * server never passes a smaller size to the PTY. The floor sits well above 2x1: a fuzz resizing
 * at random to 2-10 columns, with glibc checking the heap on every call, caught corruption too,
 * and every run at 20 columns or more was clean.
 */
export const MIN_TERMINAL_COLS = 20;
export const MIN_TERMINAL_ROWS = 2;

/** False for a size below the floor, and for NaN, which is what a malformed resize parses to. */
export function isUsableTerminalSize(cols: number, rows: number): boolean {
  return cols >= MIN_TERMINAL_COLS && rows >= MIN_TERMINAL_ROWS;
}
