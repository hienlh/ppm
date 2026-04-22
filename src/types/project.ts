export interface Project {
  name: string;
  path: string;
  color?: string;
}

export interface ProjectInfo extends Project {
  branch?: string;
  status?: "clean" | "dirty";
}

export interface FileNode {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: FileNode[];
  size?: number;
  modified?: string;
  /** True if this path is matched by a .gitignore rule */
  ignored?: boolean;
}

/** A flat file entry returned by /files/index */
export interface FileEntry {
  path: string;
  name: string;
  type: "file" | "directory";
  /** True if file is excluded by .gitignore but still surfaced in palette for discoverability (e.g. .env) */
  isIgnored?: boolean;
}

/** Entry returned by /files/list (single directory level) */
export interface FileDirEntry {
  name: string;
  type: "file" | "directory";
  /** True if entry is excluded by gitignore (informational — still listed) */
  isIgnored: boolean;
}

/** Per-project file filter override (stored in projects.settings JSON) */
export interface FileFilterConfig {
  /** Additional glob patterns to exclude from tree/list */
  filesExclude?: string[];
  /** Additional glob patterns to exclude from index/search */
  searchExclude?: string[];
  /** Whether to use .gitignore rules (null = use global setting) */
  useIgnoreFiles?: boolean;
}

/** Per-project settings stored in projects.settings JSON column */
export interface ProjectSettings {
  files?: FileFilterConfig;
  [key: string]: unknown;
}
