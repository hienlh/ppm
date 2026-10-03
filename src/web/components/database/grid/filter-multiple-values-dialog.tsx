/**
 * DBGate's Filter multiple values: a list pasted one value a line, and how a row has to match it.
 * OK writes the list into the filter box as one filter — `='active',='pending'` — which is also
 * what pasting the lines straight into the box does.
 */
import { useId, useState } from "react";
import { RadioRow, inputClass } from "../connection-form/form-controls";
import { cn } from "@/lib/utils";
import { FilterDialogFrame } from "./filter-dialog-frame";
import { linesFilter, type LinesMode } from "./grid-filters";

const MODES: { mode: LinesMode; label: string }[] = [
  { mode: "is", label: "Is one of line" },
  { mode: "isNot", label: "Is not one of line" },
  { mode: "contains", label: "Contains" },
  { mode: "begins", label: "Begins" },
  { mode: "ends", label: "Ends" },
];

export function FilterMultipleValuesDialog({ onSubmit, onClose, returnFocus }: {
  onSubmit: (text: string) => void;
  onClose: () => void;
  returnFocus?: () => void;
}) {
  const [lines, setLines] = useState("");
  const [mode, setMode] = useState<LinesMode>("is");
  const name = useId();

  const ok = () => {
    const text = linesFilter(mode, lines);
    onClose();
    if (text) onSubmit(text);
  };

  return (
    <FilterDialogFrame
      title="Filter multiple values"
      description="One value per line. OK writes them into the filter box as one filter."
      onOk={ok}
      onClose={onClose}
      returnFocus={returnFocus}
    >
      <textarea
        value={lines}
        onChange={(e) => setLines(e.target.value)}
        aria-label="One value per line"
        rows={10}
        autoFocus
        spellCheck={false}
        autoComplete="off"
        autoCapitalize="off"
        className={cn(inputClass, "h-auto min-h-[190px] resize-y py-2 font-mono leading-normal md:h-auto md:text-xs")}
      />
      <div role="radiogroup" aria-label="Match" className="flex flex-wrap gap-x-[18px] max-md:flex-col md:gap-y-1.5">
        {MODES.map((m) => (
          <RadioRow key={m.mode} name={name} value={m.mode} checked={mode === m.mode} onChange={() => setMode(m.mode)}>{m.label}</RadioRow>
        ))}
      </div>
    </FilterDialogFrame>
  );
}
