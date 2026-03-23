import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { GitBranch } from "../../../types/git";

interface GitGraphSettingsDialogProps {
  open: boolean;
  onClose: () => void;
  projectName: string;
  branches: GitBranch[];
}

export function GitGraphSettingsDialog({
  open,
  onClose,
  projectName,
  branches,
}: GitGraphSettingsDialogProps) {
  const localBranches = branches.filter((b) => !b.remote);
  const remoteBranches = branches.filter((b) => b.remote);

  // Extract unique remotes from remote branch names
  const remotes = new Map<string, string[]>();
  for (const b of remoteBranches) {
    const stripped = b.name.replace(/^remotes\//, "");
    const slashIdx = stripped.indexOf("/");
    if (slashIdx < 0) continue;
    const remoteName = stripped.slice(0, slashIdx);
    const branchName = stripped.slice(slashIdx + 1);
    const arr = remotes.get(remoteName) ?? [];
    arr.push(branchName);
    remotes.set(remoteName, arr);
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Repository Settings</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 text-sm">
          {/* General */}
          <Section title="General">
            <Row label="Name" value={projectName} />
            <Row label="Branches" value={`${localBranches.length} local, ${remoteBranches.length} remote`} />
          </Section>

          {/* Local branches */}
          <Section title="Local Branches">
            {localBranches.map((b) => (
              <div key={b.name} className="flex items-center gap-2 py-0.5">
                <span className={`text-xs ${b.current ? "font-semibold text-primary" : "text-foreground"}`}>
                  {b.name}
                </span>
                {b.current && <span className="text-[10px] text-muted-foreground italic">HEAD</span>}
                {b.remotes.length > 0 && (
                  <span className="text-[10px] text-muted-foreground">
                    ({b.remotes.join(", ")})
                  </span>
                )}
              </div>
            ))}
          </Section>

          {/* Remotes */}
          <Section title="Remotes">
            {[...remotes.entries()].map(([name, rBranches]) => (
              <div key={name} className="py-0.5">
                <span className="text-xs font-medium">{name}</span>
                <span className="text-[10px] text-muted-foreground ml-2">
                  {rBranches.length} branch{rBranches.length !== 1 ? "es" : ""}
                </span>
              </div>
            ))}
            {remotes.size === 0 && (
              <span className="text-xs text-muted-foreground">No remotes configured</span>
            )}
          </Section>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">{title}</h4>
      <div className="pl-1">{children}</div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-3 py-0.5">
      <span className="text-xs text-muted-foreground w-16 shrink-0">{label}</span>
      <span className="text-xs">{value}</span>
    </div>
  );
}
