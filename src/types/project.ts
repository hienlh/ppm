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
}
