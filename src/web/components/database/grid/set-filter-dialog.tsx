/**
 * DBGate's Set filter: two conditions joined by And or Or, opened by the funnel's "..." items on
 * the comparison chosen. It only writes text into the filter box — `>=5 <=10`, `^"ca","us"` — so
 * what it builds can be read, edited and switched off like anything typed there.
 */
import { useId, useState } from "react";
import { ChevronDown } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { RadioRow, TextInput } from "../connection-form/form-controls";
import { FilterDialogFrame } from "./filter-dialog-frame";
import {
  conditionChoices, setFilterText, takesValue,
  type Condition, type ConditionChoice, type ConditionOp, type FilterDialogRequest,
} from "./filter-funnel-menu";

export function SetFilterDialog({ request, onSubmit, onClose, returnFocus }: {
  request: Extract<FilterDialogRequest, { dialog: "condition" }>;
  /** The filter text, when the conditions say anything. */
  onSubmit: (text: string) => void;
  onClose: () => void;
  returnFocus?: () => void;
}) {
  const choices = conditionChoices(request.kind);
  const [first, setFirst] = useState<Condition>({ op: request.first, value: "" });
  const [second, setSecond] = useState<Condition>({ op: request.second, value: "" });
  const [join, setJoin] = useState<"and" | "or">("and");
  const joinName = useId();

  const ok = () => {
    const text = setFilterText(request.kind, first, join, second);
    onClose();
    if (text) onSubmit(text);
  };

  return (
    <FilterDialogFrame
      title="Set filter"
      description="Two conditions joined with And or Or. OK writes them into the filter box."
      onOk={ok}
      onClose={onClose}
      returnFocus={returnFocus}
    >
      <p className="text-[13px] text-text-2 md:text-[12.5px]">Show rows where</p>
      <ConditionRow which="First" condition={first} onChange={setFirst} choices={choices} autoFocus />
      <div role="radiogroup" aria-label="Join the two conditions" className="flex gap-[18px]">
        <RadioRow name={joinName} value="and" checked={join === "and"} onChange={() => setJoin("and")}>And</RadioRow>
        <RadioRow name={joinName} value="or" checked={join === "or"} onChange={() => setJoin("or")}>Or</RadioRow>
      </div>
      <ConditionRow which="Second" condition={second} onChange={setSecond} choices={choices} />
    </FilterDialogFrame>
  );
}

function ConditionRow({ which, condition, onChange, choices, autoFocus }: {
  which: "First" | "Second";
  condition: Condition;
  onChange: (condition: Condition) => void;
  choices: readonly ConditionChoice[];
  autoFocus?: boolean;
}) {
  const valued = takesValue(condition.op);
  return (
    <div className="flex gap-2 max-md:flex-col">
      <span className="relative flex min-w-0 md:w-[190px] md:shrink-0">
        <select
          value={condition.op}
          onChange={(e) => onChange({ ...condition, op: e.target.value as ConditionOp })}
          aria-label={`${which} condition`}
          // The comparison is all there is to choose when it takes no value.
          autoFocus={autoFocus && !valued}
          className={cn(
            "h-11 w-full min-w-0 appearance-none rounded-md border border-border bg-surface pr-7 pl-2.5 text-[15px] text-text-primary outline-none focus:border-ring",
            "md:h-[30px] md:font-mono md:text-xs",
          )}
        >
          {choices.map((c) => <option key={c.op} value={c.op}>{c.label}</option>)}
        </select>
        <ChevronDown className="pointer-events-none absolute top-1/2 right-2 size-3.5 -translate-y-1/2 text-text-subtle" />
      </span>
      {valued && (
        <TextInput
          value={condition.value}
          onChange={(e) => onChange({ ...condition, value: e.target.value })}
          aria-label={`${which} value`}
          autoFocus={autoFocus}
          // The select before it is the first field, which is where the dialog would start.
          data-autofocus={autoFocus ? "" : undefined}
          mono={condition.op === "sql" || condition.op === "sqlRight"}
        />
      )}
    </div>
  );
}
