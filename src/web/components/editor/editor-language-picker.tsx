import { FileCode } from "lucide-react";

/** Monaco language ids offered in the picker (built-in support only). */
export const EDITOR_LANGUAGES: { id: string; label: string }[] = [
  { id: "plaintext", label: "Plain Text" },
  { id: "javascript", label: "JavaScript" },
  { id: "typescript", label: "TypeScript" },
  { id: "sql", label: "SQL" },
  { id: "json", label: "JSON" },
  { id: "xml", label: "XML" },
  { id: "html", label: "HTML" },
  { id: "css", label: "CSS" },
  { id: "python", label: "Python" },
  { id: "markdown", label: "Markdown" },
  { id: "yaml", label: "YAML" },
  { id: "shell", label: "Shell" },
];

interface Props {
  /** Currently effective Monaco language id */
  value: string;
  onChange: (language: string) => void;
}

/** Small dropdown to override the editor's Monaco language (desktop bar). */
export function EditorLanguagePicker({ value, onChange }: Props) {
  return (
    <div className="shrink-0 flex items-center gap-1 px-2 border-l border-border">
      <FileCode className="size-3 text-muted-foreground" />
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-5 text-[10px] bg-transparent border border-border rounded px-1 text-foreground outline-none max-w-[120px]"
        title="Select editor language"
      >
        {EDITOR_LANGUAGES.map((l) => (
          <option key={l.id} value={l.id}>{l.label}</option>
        ))}
      </select>
    </div>
  );
}
