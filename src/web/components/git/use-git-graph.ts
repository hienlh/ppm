import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { api, projectUrl } from "@/lib/api-client";
import { useTabStore } from "@/stores/tab-store";
import type { GitGraphData, GitCommit } from "../../../types/git";
import { buildCommitLabels, computeLanes, computeSvgPaths, ROW_HEIGHT } from "./git-graph-constants";

const PAGE_SIZE = 200;

export function useGitGraph(projectName: string | undefined) {
  const [data, setData] = useState<GitGraphData | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [acting, setActing] = useState(false);
  const [selectedCommit, setSelectedCommit] = useState<GitCommit | null>(null);
  const [commitFiles, setCommitFiles] = useState<
    Array<{ path: string; additions: number; deletions: number }>
  >([]);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [branchFilter, setBranchFilter] = useState("__all__");
  const [searchQuery, setSearchQuery] = useState("");
  const [showSearch, setShowSearch] = useState(false);
  const { openTab } = useTabStore();
  const loadedCountRef = useRef(0);

  const fetchGraph = useCallback(async () => {
    if (!projectName) return;
    try {
      setLoading(true);
      // Fetch at least PAGE_SIZE, but if we've loaded more via pagination, re-fetch all
      const count = Math.max(PAGE_SIZE, loadedCountRef.current);
      const result = await api.get<GitGraphData>(
        `${projectUrl(projectName)}/git/graph?max=${count}`,
      );
      setData(result);
      loadedCountRef.current = result.commits.length;
      setHasMore(result.commits.length >= count);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to fetch graph");
    } finally {
      setLoading(false);
    }
  }, [projectName]);

  const loadMore = useCallback(async () => {
    if (!projectName || loadingMore || !hasMore) return;
    try {
      setLoadingMore(true);
      const skip = loadedCountRef.current;
      const result = await api.get<GitGraphData>(
        `${projectUrl(projectName)}/git/graph?max=${PAGE_SIZE}&skip=${skip}`,
      );
      if (result.commits.length === 0) {
        setHasMore(false);
        return;
      }
      setData((prev) => {
        if (!prev) return result;
        // Deduplicate by hash
        const existing = new Set(prev.commits.map((c) => c.hash));
        const newCommits = result.commits.filter((c) => !existing.has(c.hash));
        // Merge branches: keep existing + add new remote-only branches
        const existingBranches = new Set(prev.branches.map((b) => b.name));
        const newBranches = result.branches.filter((b) => !existingBranches.has(b.name));
        return {
          commits: [...prev.commits, ...newCommits],
          branches: [...prev.branches, ...newBranches],
          head: prev.head,
        };
      });
      loadedCountRef.current = skip + result.commits.length;
      setHasMore(result.commits.length >= PAGE_SIZE);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load more");
    } finally {
      setLoadingMore(false);
    }
  }, [projectName, loadingMore, hasMore]);

  useEffect(() => {
    fetchGraph();
    const interval = setInterval(fetchGraph, 10000);
    return () => clearInterval(interval);
  }, [fetchGraph]);

  const gitAction = async (path: string, body: Record<string, unknown>) => {
    if (!projectName) return;
    setActing(true);
    try { await api.post(`${projectUrl(projectName)}${path}`, body); await fetchGraph(); }
    catch (e) { setError(e instanceof Error ? e.message : "Action failed"); }
    finally { setActing(false); }
  };

  const fetchFromRemotes = () => gitAction("/git/fetch", {});
  const handleCheckout = (ref: string) => gitAction("/git/checkout", { ref });
  const handleCherryPick = (hash: string) => gitAction("/git/cherry-pick", { hash });
  const handleRevert = (hash: string) => gitAction("/git/revert", { hash });
  const handleMerge = (source: string) => gitAction("/git/merge", { source });
  const handleDeleteBranch = (name: string) => gitAction("/git/branch/delete", { name });
  const handlePushBranch = (branch: string) => gitAction("/git/push", { branch });
  const handleCreateTag = (name: string, hash?: string) => gitAction("/git/tag", { name, hash });
  const copyHash = (hash: string) => navigator.clipboard.writeText(hash);

  const handleCreateBranch = async (name: string, from: string) => {
    const exists = data?.branches.some((b) => b.name === name || b.name.endsWith(`/${name}`));
    if (exists) {
      if (!window.confirm(`Branch "${name}" already exists.\nDelete and recreate from this commit?`)) return;
      await gitAction("/git/branch/delete", { name });
    }
    await gitAction("/git/branch/create", { name, from });
  };

  const handleCreatePr = async (branch: string) => {
    if (!projectName) return;
    try {
      const r = await api.get<{ url: string | null }>(`${projectUrl(projectName)}/git/pr-url?branch=${encodeURIComponent(branch)}`);
      if (r.url) window.open(r.url, "_blank");
    } catch { /* silent */ }
  };

  const selectCommit = async (commit: GitCommit) => {
    if (selectedCommit?.hash === commit.hash) { setSelectedCommit(null); return; }
    setSelectedCommit(commit);
    setLoadingDetail(true);
    try {
      const parent = commit.parents[0] ?? "";
      const ref1Param = parent ? `ref1=${encodeURIComponent(parent)}&` : "";
      const files = await api.get<Array<{ path: string; additions: number; deletions: number }>>(
        `${projectUrl(projectName!)}/git/diff-stat?${ref1Param}ref2=${encodeURIComponent(commit.hash)}`);
      setCommitFiles(Array.isArray(files) ? files : []);
    } catch { setCommitFiles([]); }
    finally { setLoadingDetail(false); }
  };

  const openDiffForCommit = (commit: GitCommit) => openTab({
    type: "git-diff", title: `Diff ${commit.abbreviatedHash}`, closable: true,
    metadata: { projectName, ref1: commit.parents[0] ?? undefined, ref2: commit.hash },
    projectId: projectName ?? null,
  });

  // --- Computed ---
  const commitLabels = useMemo(() => buildCommitLabels(data), [data]);
  const currentBranch = data?.branches.find((b) => b.current);
  const headHash = data?.head ?? "";

  const filteredCommits = useMemo(() => {
    if (!data) return [];
    let commits = data.commits;
    if (branchFilter !== "__all__") {
      const branch = data.branches.find((b) => b.name === branchFilter);
      if (branch) {
        const reachable = new Set<string>();
        const queue = [branch.commitHash];
        while (queue.length > 0) {
          const hash = queue.pop()!;
          if (reachable.has(hash)) continue;
          reachable.add(hash);
          const c = data.commits.find((cm) => cm.hash === hash);
          if (c) queue.push(...c.parents);
        }
        commits = commits.filter((c) => reachable.has(c.hash));
      }
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      commits = commits.filter(
        (c) =>
          c.subject.toLowerCase().includes(q) ||
          c.authorName.toLowerCase().includes(q) ||
          c.abbreviatedHash.includes(q) ||
          c.hash.includes(q),
      );
    }
    return commits;
  }, [data, branchFilter, searchQuery]);

  const filteredData = useMemo(() => (data ? { ...data, commits: filteredCommits } : null), [data, filteredCommits]);
  const filteredLanes = useMemo(() => computeLanes(filteredData), [filteredData]);
  const svgHeight = filteredCommits.length * ROW_HEIGHT + ROW_HEIGHT * 2; // extra padding for unloaded-parent lines
  const svgPaths = useMemo(
    () => computeSvgPaths(filteredData, filteredLanes.laneMap, filteredLanes.unloadedParentLanes, svgHeight),
    [filteredData, filteredLanes.laneMap, filteredLanes.unloadedParentLanes, svgHeight]);

  return {
    data, loading, loadingMore, hasMore, error, acting,
    selectedCommit, setSelectedCommit,
    commitFiles, loadingDetail,
    branchFilter, setBranchFilter,
    searchQuery, setSearchQuery,
    showSearch, setShowSearch,
    fetchGraph, fetchFromRemotes, loadMore,
    handleCheckout, handleCherryPick, handleRevert,
    handleMerge, handleDeleteBranch, handlePushBranch,
    handleCreateBranch, handleCreateTag, handleCreatePr,
    copyHash, selectCommit, openDiffForCommit,
    commitLabels, currentBranch, headHash,
    filteredCommits, filteredLanes, svgHeight, svgPaths,
  };
}
