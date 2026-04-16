import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { X } from "lucide-react";

interface FilterState {
  project: string[];
  issueType: string[];
  priority: string[];
  status: string[];
}

function filtersToJql(filters: FilterState): string {
  const clauses: string[] = [];
  if (filters.project.length) clauses.push(`project IN (${filters.project.join(", ")})`);
  if (filters.issueType.length) clauses.push(`issuetype IN (${filters.issueType.map((v) => `"${v}"`).join(", ")})`);
  if (filters.priority.length) clauses.push(`priority IN (${filters.priority.map((v) => `"${v}"`).join(", ")})`);
  if (filters.status.length) clauses.push(`status IN (${filters.status.map((v) => `"${v}"`).join(", ")})`);
  return (clauses.join(" AND ") || "ORDER BY updated DESC") + (clauses.length ? " ORDER BY updated DESC" : "");
}

const EMPTY_FILTERS: FilterState = { project: [], issueType: [], priority: [], status: [] };

interface Props {
  value: string;
  onChange: (jql: string) => void;
}

export function JiraFilterBuilder({ value, onChange }: Props) {
  const [mode, setMode] = useState<"builder" | "raw">(value ? "raw" : "builder");
  const [filters, setFilters] = useState<FilterState>(EMPTY_FILTERS);
  const [rawJql, setRawJql] = useState(value);

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
          <FilterField label="Project" field="project" filters={filters} onAdd={addValue} onRemove={removeValue} placeholder="PROJ" />
          <FilterField label="Issue Type" field="issueType" filters={filters} onAdd={addValue} onRemove={removeValue} placeholder="Bug" />
          <FilterField label="Priority" field="priority" filters={filters} onAdd={addValue} onRemove={removeValue} placeholder="High" />
          <FilterField label="Status" field="status" filters={filters} onAdd={addValue} onRemove={removeValue} placeholder="To Do" />
        </div>
      )}

      {/* JQL preview */}
      <div className="text-xs text-muted-foreground bg-muted/50 rounded px-2 py-1 font-mono break-all">
        {mode === "builder" ? filtersToJql(filters) : rawJql || "(empty)"}
      </div>
    </div>
  );
}

function FilterField({ label, field, filters, onAdd, onRemove, placeholder }: {
  label: string; field: keyof FilterState; filters: FilterState;
  onAdd: (f: keyof FilterState, v: string) => void;
  onRemove: (f: keyof FilterState, v: string) => void;
  placeholder: string;
}) {
  const [input, setInput] = useState("");
  const handleAdd = () => { if (input.trim()) { onAdd(field, input.trim()); setInput(""); } };

  return (
    <div>
      <label className="text-xs text-muted-foreground">{label}</label>
      <div className="flex items-center gap-1 flex-wrap">
        {filters[field].map((v) => (
          <span key={v} className="inline-flex items-center gap-0.5 px-2 py-0.5 rounded-full bg-primary/10 text-xs">
            {v}
            <button type="button" onClick={() => onRemove(field, v)} className="hover:text-destructive">
              <X className="size-3" />
            </button>
          </span>
        ))}
        <Input
          value={input} onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); handleAdd(); } }}
          placeholder={placeholder} className="h-7 w-24 text-xs flex-shrink-0"
        />
      </div>
    </div>
  );
}
