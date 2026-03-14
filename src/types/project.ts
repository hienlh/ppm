/** A registered project in PPM */
export interface Project {
  name: string;
  path: string;
  /** Whether .git directory exists */
  hasGit: boolean;
}

/** Lightweight project info for listing */
export interface ProjectInfo {
  name: string;
  path: string;
  hasGit: boolean;
}
