import type { GitGraphData } from "../../../types/git";

export const LANE_COLORS = [
  "#0085d9", "#d73a49", "#6f42c1", "#2cbe4e", "#e36209",
  "#005cc5", "#b31d28", "#5a32a3", "#22863a", "#cb2431",
];

export const ROW_HEIGHT = 24;
export const LANE_WIDTH = 16;
export const NODE_RADIUS = 4;

/** Build commit → branch/tag label map (shows local + remote-only branches) */
export function buildCommitLabels(data: GitGraphData | null) {
  const labels = new Map<string, Array<{ name: string; type: "branch" | "tag"; remotes: string[]; current: boolean }>>();
  if (!data) return labels;

  // Collect which remote branches are already covered by a local branch
  const coveredRemotes = new Set<string>();
  for (const branch of data.branches) {
    if (!branch.remote) {
      for (const remote of branch.remotes) {
        coveredRemotes.add(`remotes/${remote}/${branch.name}`);
      }
    }
  }

  for (const branch of data.branches) {
    if (branch.remote) {
      // Show remote-only branches (not covered by a local branch)
      if (coveredRemotes.has(branch.name)) continue;
      const arr = labels.get(branch.commitHash) ?? [];
      // Display as "remote/branch" (strip "remotes/" prefix)
      const displayName = branch.name.replace(/^remotes\//, "");
      arr.push({ name: displayName, type: "branch", remotes: [], current: false });
      labels.set(branch.commitHash, arr);
    } else {
      const arr = labels.get(branch.commitHash) ?? [];
      arr.push({ name: branch.name, type: "branch", remotes: branch.remotes, current: branch.current });
      labels.set(branch.commitHash, arr);
    }
  }

  for (const commit of data.commits) {
    for (const ref of commit.refs) {
      if (ref.startsWith("tag: ")) {
        const tagName = ref.replace("tag: ", "");
        const arr = labels.get(commit.hash) ?? [];
        arr.push({ name: tagName, type: "tag", remotes: [], current: false });
        labels.set(commit.hash, arr);
      }
    }
  }
  return labels;
}

/** Lane assignment algorithm — recycles freed lanes to keep graph compact */
export function computeLanes(data: GitGraphData | null) {
  const map = new Map<string, number>();
  if (!data) return { laneMap: map, maxLane: 0, unloadedParentLanes: new Map<string, number>() };

  let nextLane = 0;
  let maxLaneUsed = 0;
  const activeLanes = new Map<string, number>();
  const commitSet = new Set(data.commits.map((c) => c.hash));
  const freeLanes: number[] = [];

  const allocLane = () => {
    if (freeLanes.length > 0) {
      freeLanes.sort((a, b) => a - b);
      return freeLanes.shift()!;
    }
    return nextLane++;
  };

  for (const commit of data.commits) {
    let lane = activeLanes.get(commit.hash);
    if (lane === undefined) lane = allocLane();
    map.set(commit.hash, lane);
    if (lane > maxLaneUsed) maxLaneUsed = lane;
    activeLanes.delete(commit.hash);

    let laneReused = false;
    for (let i = 0; i < commit.parents.length; i++) {
      const parent = commit.parents[i]!;
      if (!activeLanes.has(parent)) {
        if (i === 0) {
          activeLanes.set(parent, lane);
          laneReused = true;
        } else {
          const newLane = allocLane();
          activeLanes.set(parent, newLane);
          if (newLane > maxLaneUsed) maxLaneUsed = newLane;
        }
      }
    }
    if (!laneReused) freeLanes.push(lane);
  }

  const unloadedParentLanes = new Map<string, number>();
  for (const [hash, lane] of activeLanes) {
    if (!commitSet.has(hash)) unloadedParentLanes.set(hash, lane);
  }

  return { laneMap: map, maxLane: maxLaneUsed, unloadedParentLanes };
}

/** Build SVG paths for connections (including unloaded parent extension) */
export function computeSvgPaths(
  data: GitGraphData | null,
  laneMap: Map<string, number>,
  unloadedParentLanes: Map<string, number>,
  totalHeight: number,
) {
  if (!data) return [];
  const paths: Array<{ d: string; color: string }> = [];
  const commitSet = new Set(data.commits.map((c) => c.hash));

  for (let idx = 0; idx < data.commits.length; idx++) {
    const commit = data.commits[idx]!;
    const lane = laneMap.get(commit.hash) ?? 0;
    const color = LANE_COLORS[lane % LANE_COLORS.length]!;

    for (const parentHash of commit.parents) {
      const parentIdx = data.commits.findIndex((c) => c.hash === parentHash);

      if (parentIdx >= 0) {
        // Parent is loaded — draw connection
        const parentLane = laneMap.get(parentHash) ?? 0;
        const parentColor = LANE_COLORS[parentLane % LANE_COLORS.length]!;
        const x1 = lane * LANE_WIDTH + LANE_WIDTH / 2;
        const y1 = idx * ROW_HEIGHT + ROW_HEIGHT / 2;
        const x2 = parentLane * LANE_WIDTH + LANE_WIDTH / 2;
        const y2 = parentIdx * ROW_HEIGHT + ROW_HEIGHT / 2;

        let d: string;
        const isMerge = commit.parents.indexOf(parentHash) > 0;
        if (x1 === x2) {
          d = `M ${x1} ${y1} L ${x2} ${y2}`;
        } else if (isMerge) {
          const curveEnd = y1 + ROW_HEIGHT;
          d = `M ${x1} ${y1} C ${x1} ${curveEnd} ${x2} ${y1} ${x2} ${curveEnd} L ${x2} ${y2}`;
        } else {
          const curveStart = y2 - ROW_HEIGHT;
          d = `M ${x1} ${y1} L ${x1} ${curveStart} C ${x1} ${y2} ${x2} ${curveStart} ${x2} ${y2}`;
        }
        const lineColor = commit.parents.indexOf(parentHash) === 0 ? color : parentColor;
        paths.push({ d, color: lineColor });
      } else if (!commitSet.has(parentHash)) {
        // Parent NOT loaded — use the parent's assigned lane for the extension line
        const parentLane = unloadedParentLanes.get(parentHash) ?? lane;
        const parentColor = LANE_COLORS[parentLane % LANE_COLORS.length]!;
        const x1 = lane * LANE_WIDTH + LANE_WIDTH / 2;
        const y1 = idx * ROW_HEIGHT + ROW_HEIGHT / 2;
        const x2 = parentLane * LANE_WIDTH + LANE_WIDTH / 2;

        if (x1 === x2) {
          // Same lane — straight down
          paths.push({ d: `M ${x1} ${y1} L ${x1} ${totalHeight}`, color });
        } else {
          // Different lane — curve then straight down
          const curveEnd = y1 + ROW_HEIGHT;
          const d = `M ${x1} ${y1} C ${x1} ${curveEnd} ${x2} ${y1} ${x2} ${curveEnd} L ${x2} ${totalHeight}`;
          paths.push({ d, color: parentColor });
        }
      }
    }
  }
  return paths;
}

export function relativeDate(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 30) return `${diffDays}d ago`;
  const diffMonths = Math.floor(diffDays / 30);
  if (diffMonths < 12) return `${diffMonths}mo ago`;
  return `${Math.floor(diffMonths / 12)}y ago`;
}
