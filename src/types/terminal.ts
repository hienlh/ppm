/** Terminal session managed by node-pty */
export interface TerminalSession {
  id: string;
  pid: number;
  cols: number;
  rows: number;
  cwd: string;
}

export interface TerminalResize {
  cols: number;
  rows: number;
}
