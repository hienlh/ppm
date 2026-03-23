import { LANE_COLORS, LANE_WIDTH, ROW_HEIGHT, NODE_RADIUS } from "./git-graph-constants";
import type { GitCommit } from "../../../types/git";

interface GitGraphSvgProps {
  commits: GitCommit[];
  laneMap: Map<string, number>;
  svgPaths: Array<{ d: string; color: string }>;
  width: number;
  height: number;
  headHash: string;
}

export function GitGraphSvg({
  commits,
  laneMap,
  svgPaths,
  width,
  height,
  headHash,
}: GitGraphSvgProps) {
  return (
    <svg width={width} height={height}>
      {/* Connection lines */}
      {svgPaths.map((p, i) => (
        <path
          key={i}
          d={p.d}
          stroke={p.color}
          strokeWidth={2}
          fill="none"
        />
      ))}
      {/* Commit dots */}
      {commits.map((c, ci) => {
        const cLane = laneMap.get(c.hash) ?? 0;
        const cx = cLane * LANE_WIDTH + LANE_WIDTH / 2;
        const cy = ci * ROW_HEIGHT + ROW_HEIGHT / 2;
        const cColor = LANE_COLORS[cLane % LANE_COLORS.length]!;
        const isHead = c.hash === headHash;
        return (
          <circle
            key={c.hash}
            cx={cx}
            cy={cy}
            r={isHead ? NODE_RADIUS + 1 : NODE_RADIUS}
            fill={cColor}
            stroke={isHead ? "#000" : "none"}
            strokeWidth={isHead ? 2 : 0}
          />
        );
      })}
    </svg>
  );
}
