/** Standard API response wrapper */
export interface ApiResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

/** File entry in file tree */
export interface FileEntry {
  name: string;
  path: string;
  type: "file" | "directory";
  size?: number;
  children?: FileEntry[];
}

/** WebSocket message envelope */
export interface WsMessage<T = unknown> {
  type: string;
  payload: T;
}
