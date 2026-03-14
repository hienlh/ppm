export interface TerminalSession {
  id: string;
  projectPath: string;
  shell: string;
  createdAt: Date;
  lastActivity: Date;
}

export interface TerminalSessionInfo {
  id: string;
  projectPath: string;
  shell: string;
  createdAt: string;
  lastActivity: string;
}

export interface TerminalResize {
  cols: number;
  rows: number;
}
