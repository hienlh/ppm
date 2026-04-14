/**
 * Parse git log output into structured GitVertex objects.
 * Uses custom format: %H%n%P%n%an%n%ae%n%at%n%cn%n%ce%n%ct%n%D%n%s%n<END_COMMIT>
 */
import type { GitVertex, RefData } from "./types.ts";

export function parseGitLog(stdout: string): GitVertex[] {
  const blocks = stdout.split("<END_COMMIT>").filter((b) => b.trim());
  return blocks.map(parseCommitBlock).filter(Boolean) as GitVertex[];
}

function parseCommitBlock(block: string): GitVertex | null {
  const lines = block.trim().split("\n");
  if (lines.length < 10) return null;

  const hash = lines[0];
  const parents = lines[1] ? lines[1].split(" ").filter(Boolean) : [];
  const author = lines[2];
  const authorEmail = lines[3];
  const authorDate = parseInt(lines[4], 10);
  const committer = lines[5];
  const committerEmail = lines[6];
  const commitDate = parseInt(lines[7], 10);
  const refs = parseRefs(lines[8]);
  const message = lines[9];

  return { hash, parents, author, authorEmail, authorDate, committer, committerEmail, commitDate, refs, message };
}

function parseRefs(refString: string): RefData[] {
  if (!refString.trim()) return [];
  return refString.split(",").map((r) => r.trim()).filter(Boolean).map((ref) => {
    if (ref.startsWith("HEAD -> ")) return { name: ref.replace("HEAD -> ", ""), type: "head" as const };
    if (ref.startsWith("tag: ")) return { name: ref.replace("tag: ", ""), type: "tag" as const };
    if (ref.includes("/")) return { name: ref, type: "remote" as const };
    return { name: ref, type: "local" as const };
  });
}
