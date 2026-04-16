import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { X, Loader2 } from "lucide-react";
import { api } from "@/lib/api-client";

interface FilterState {
  project: string[];
  issueType: string[];
  priority: string[];
  status: string[];
  assignee: string[];
}

function filtersToJql(filters: FilterState): string {
  const clauses: string[] = [];
  if (filters.project.length) clauses.push(`project IN (${filters.project.join(", ")})`);
  if (filters.issueType.length) clauses.push(`issuetype IN (${filters.issueType.map((v) => `"${v}"`).join(", ")})`);
  if (filters.priority.length) clauses.push(`priority IN (${filters.priority.map((v) => `"${v}"`).join(", ")})`);
  if (filters.status.length) clauses.push(`status IN (${filters.status.map((v) => `"${v}"`).join(", ")})`);
  if (filters.assignee.length) clauses.push(`assignee IN (${filters.assignee.map((v) => `"${v}"`).join(", ")})`);
  return (clauses.join(" AND ") || "ORDER BY updated DESC") + (clauses.length ? " ORDER BY updated DESC" : "");
}

const EMPTY_FILTERS: FilterState = { project: [], issueType: [], priority: [], status: [], assignee: [] };

interface FieldOption { id?: string; key?: string; name: string }

interface Props {
  value: string;
  onChange: (jql: string) => void;
  configId: number;
}

export function JiraFilterBuilder({ value, onChange, configId }: Props) {
  const [mode, setMode] = useState<"builder" | "raw">(value ? "raw" : "builder");
  const [filters, setFilters] = useState<FilterState>(EMPTY_FILTERS);
  const [rawJql, setRawJql] = useState(value);

  // Metadata options fetched from Jira API
  const [projects, setProjects] = useState<FieldOption[]>([]);
  const [issueTypes, setIssueTypes] = useState<FieldOption[]>([]);
  const [priorities, setPriorities] = useState<FieldOption[]>([]);
  const [statuses, setStatuses] = useState<FieldOption[]>([]);
  const [assignees, setAssignees] = useState<FieldOption[]>([]);
  const [loading, setLoading] = useState(false);

  // Fetch metadata when configId changes
  useEffect(() => {
    if (!configId) return;
    setLoading(true);
    Promise.all([
      api.get<FieldOption[]>(`/api/jira/metadata/${configId}/projects`).catch(() => []),
      api.get<FieldOption[]>(`/api/jira/metadata/${configId}/issuetype`).catch(() => []),
      api.get<FieldOption[]>(`/api/jira/metadata/${configId}/priority`).catch(() => []),
      api.get<FieldOption[]>(`/api/jira/metadata/${configId}/status`).catch(() => []),
      api.get<Array<{ accountId: string; displayName: string }>>(`/api/jira/metadata/${configId}/assignees`).catch(() => []),
    ]).then(([p, it, pr, st, as_]) => {
      setProjects(p);
      setIssueTypes(it);
      setPriorities(pr);
      setStatuses(st);
      setAssignees(as_.map((u) => ({ id: u.accountId, name: u.displayName })));
    }).finally(() => setLoading(false));
  }, [configId]);

  // Sync builder → JQL
  useEffect(() => {
    if (mode === "builder") {
      const jql = filtersToJql(filters);
      onChange(jql);
    }
  }, [filters, mode]);

  const handleRawChange = useCallback((val: string) => {
    setRawJql(val);
    onChange(val);
  }, [onChange]);

  const addValue = (field: keyof FilterState, val: string) => {
    if (!val || filters[field].includes(val)) return;
    setFilters((f) => ({ ...f, [field]: [...f[field], val] }));
  };

  const removeValue = (field: keyof FilterState, val: string) => {
    setFilters((f) => ({ ...f, [field]: f[field].filter((v) => v !== val) }));
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Button
          type="button" size="sm" variant={mode === "builder" ? "default" : "outline"}
          onClick={() => setMode("builder")} className="min-h-[44px] text-xs"
        >Builder</Button>
        <Button
          type="button" size="sm" variant={mode === "raw" ? "default" : "outline"}
          onClick={() => setMode("raw")} className="min-h-[44px] text-xs"
        >Raw JQL</Button>
        {loading && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
      </div>

      {mode === "raw" ? (
        <textarea
          value={rawJql}
          onChange={(e) => handleRawChange(e.target.value)}
          className="w-full h-20 rounded-md border border-input bg-background px-3 py-2 text-sm font-mono resize-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          placeholder='e.g. project = MYPROJ AND status = "In Progress"'
        />
      ) : (
        <div className="space-y-2">
          <FilterField
            label="Project" field="project" filters={filters}
            onAdd={addValue} onRemove={removeValue}
            options={projects.map((p) => ({ value: p.key ?? p.name, label: `${p.key ?? p.name} — ${p.name}` }))}
            placeholder="Select project..."
          />
          <FilterField
            label="Issue Type" field="issueType" filters={filters}
            onAdd={addValue} onRemove={removeValue}
            options={issueTypes.map((t) => ({ value: t.name, label: t.name }))}
            placeholder="Select issue type..."
          />
          <FilterField
            label="Priority" field="priority" filters={filters}
            onAdd={addValue} onRemove={removeValue}
            options={priorities.map((p) => ({ value: p.name, label: p.name }))}
            placeholder="Select priority..."
          />
          <FilterField
            label="Status" field="status" filters={filters}
            onAdd={addValue} onRemove={removeValue}
            options={statuses.map((s) => ({ value: s.name, label: s.name }))}
            placeholder="Select status..."
          />
          <FilterField
            label="Assignee" field="assignee" filters={filters}
            onAdd={addValue} onRemove={removeValue}
            options={assignees.map((a) => ({ value: a.id ?? a.name, label: a.name }))}
            placeholder="Select assignee..."
          />
        </div>
      )}

      {/* JQL preview */}
      <div className="text-xs text-muted-foreground bg-muted/50 rounded px-2 py-1 font-mono break-all">
        {mode === "builder" ? filtersToJql(filters) : rawJql || "(empty)"}
      </div>
    </div>
  );
}

function FilterField({ label, field, filters, onAdd, onRemove, options, placeholder }: {
  label: string; field: keyof FilterState; filters: FilterState;
  onAdd: (f: keyof FilterState, v: string) => void;
  onRemove: (f: keyof FilterState, v: string) => void;
  options: Array<{ value: string; label: string }>;
  placeholder: string;
}) {
  // Filter out already-selected options
  const available = options.filter((o) => !filters[field].includes(o.value));

  return (
    <div>
      <label className="text-xs text-muted-foreground">{label}</label>
      <div className="flex items-center gap-1 flex-wrap">
        {filters[field].map((v) => {
          const displayLabel = options.find((o) => o.value === v)?.label ?? v;
          return (
            <span key={v} className="inline-flex items-center gap-0.5 px-2 py-0.5 rounded-full bg-primary/10 text-xs">
              {displayLabel}
              <button type="button" onClick={() => onRemove(field, v)} className="hover:text-destructive">
                <X className="size-3" />
              </button>
            </span>
          );
        })}
        {available.length > 0 ? (
          <Select onValueChange={(v) => onAdd(field, v)}>
            <SelectTrigger className="h-7 w-auto min-w-[120px] text-xs">
              <SelectValue placeholder={placeholder} />
            </SelectTrigger>
            <SelectContent>
              {available.map((o) => (
                <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : options.length > 0 ? (
          <span className="text-xs text-muted-foreground italic">All selected</span>
        ) : (
          <span className="text-xs text-muted-foreground italic">Loading...</span>
        )}
      </div>
    </div>
  );
}
