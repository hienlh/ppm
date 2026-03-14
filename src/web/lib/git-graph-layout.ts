import type { GitCommit } from "../../types/git.ts";

export interface CommitLayout {
  lane: number;
  color: string;
}

const LANE_COLORS = [
  "#6366f1", // indigo
  "#22c55e", // green
  "#f59e0b", // amber
  "#ef4444", // red
  "#06b6d4", // cyan
  "#a855f7", // purple
  "#f97316", // orange
  "#14b8a6", // teal
  "#ec4899", // pink
  "#84cc16", // lime
];

export function computeGraphLayout(commits: GitCommit[]): Map<string, CommitLayout> {
  const layout = new Map<string, CommitLayout>();
  // lane -> hash of the commit currently "owning" that lane
  const lanes: (string | null)[] = [];

  const getColor = (lane: number) => LANE_COLORS[lane % LANE_COLORS.length]!;

  const allocateLane = (): number => {
    const free = lanes.indexOf(null);
    if (free !== -1) return free;
    lanes.push(null);
    return lanes.length - 1;
  };

  for (const commit of commits) {
    // Find if any lane is tracking this commit (it's a child's parent)
    let lane = lanes.indexOf(commit.hash);

    if (lane === -1) {
      // No child claimed this commit yet — it's a new branch head
      lane = allocateLane();
    }

    layout.set(commit.hash, { lane, color: getColor(lane) });

    // Update lane ownership: first parent continues the lane
    const [firstParent, ...otherParents] = commit.parents;

    if (firstParent) {
      lanes[lane] = firstParent;
    } else {
      lanes[lane] = null; // branch ends here
    }

    // Each additional parent (merge sources) gets a new lane if not already tracked
    for (const parent of otherParents) {
      if (!lanes.includes(parent)) {
        const newLane = allocateLane();
        lanes[newLane] = parent;
      }
    }
  }

  return layout;
}
