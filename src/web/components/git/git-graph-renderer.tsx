import type { CommitLayout } from "../../lib/git-graph-layout.ts";
import type { GitCommit } from "../../../types/git.ts";

export const ROW_HEIGHT = 32;
export const LANE_WIDTH = 16;
export const DOT_RADIUS = 5;
export const H_PADDING = 8;

interface Props {
  commits: GitCommit[];
  layout: Map<string, CommitLayout>;
  maxLane: number;
}

export function GitGraphRenderer({ commits, layout, maxLane }: Props) {
  const svgWidth = H_PADDING * 2 + (maxLane + 1) * LANE_WIDTH;
  const svgHeight = commits.length * ROW_HEIGHT;

  const paths: React.ReactNode[] = [];
  const dots: React.ReactNode[] = [];

  const cx = (lane: number) => H_PADDING + lane * LANE_WIDTH;
  const cy = (rowIndex: number) => rowIndex * ROW_HEIGHT + ROW_HEIGHT / 2;

  // Build hash→index map for quick parent lookups
  const indexByHash = new Map<string, number>();
  commits.forEach((c, i) => indexByHash.set(c.hash, i));

  commits.forEach((commit, i) => {
    const cl = layout.get(commit.hash);
    if (!cl) return;

    const x = cx(cl.lane);
    const y = cy(i);

    // Draw line from this commit down to each parent
    for (const parentHash of commit.parents) {
      const pi = indexByHash.get(parentHash);
      if (pi === undefined) continue;
      const pl = layout.get(parentHash);
      if (!pl) continue;

      const px = cx(pl.lane);
      const py = cy(pi);

      if (cl.lane === pl.lane) {
        // Straight vertical line
        paths.push(
          <line key={`${commit.hash}-${parentHash}`} x1={x} y1={y} x2={px} y2={py}
            stroke={cl.color} strokeWidth={2} />,
        );
      } else {
        // Curved path: go down then across
        const midY = y + ROW_HEIGHT * 0.6;
        paths.push(
          <path
            key={`${commit.hash}-${parentHash}`}
            d={`M ${x} ${y} C ${x} ${midY} ${px} ${midY} ${px} ${py}`}
            fill="none" stroke={cl.color} strokeWidth={2}
          />,
        );
      }
    }

    // Commit dot
    dots.push(
      <circle key={commit.hash} cx={x} cy={y} r={DOT_RADIUS}
        fill={cl.color} stroke="var(--background)" strokeWidth={1.5} />,
    );
  });

  return (
    <svg width={svgWidth} height={svgHeight} style={{ display: "block", flexShrink: 0 }}>
      {paths}
      {dots}
    </svg>
  );
}
