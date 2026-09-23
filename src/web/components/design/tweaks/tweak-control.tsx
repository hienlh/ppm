import { useEffect, useId, useState } from "react";
import { AlertTriangle } from "@/lib/icons";
import { Input } from "@/components/ui/input";
import { hexForColorInput, rangeNumberOf } from "@/lib/design/design-tweaks-model";
import {
  COLOR_VALUE_RE, formatRangeValue, type ColorTweak, type RangeTweak, type SelectTweak, type TweakDef,
} from "../../../../shared/design-tweaks";
import type { TweakWinner } from "../../../../shared/design-bridge-messages-tweaks";

/**
 * One tweak's control, labelled above its input (design guideline 8): a slider with a
 * readout, a colour well with a hex field, or a native `<select>`. Every input is at least
 * 44px tall on touch screens. A control only ever reports a value its type allows; a hex
 * field mid-typing reports nothing until it holds a whole colour.
 */

interface ControlProps<T extends TweakDef> {
  def: T;
  value: string;
  onChange: (value: string) => void;
  inputId: string;
}

function RangeControl({ def, value, onChange, inputId }: ControlProps<RangeTweak>) {
  return (
    <div className="flex items-center gap-3">
      <input id={inputId} type="range" min={def.min} max={def.max} step={def.step} value={rangeNumberOf(def, value)}
        onChange={(e) => onChange(formatRangeValue(def, Number(e.target.value)))}
        className="h-11 min-w-0 flex-1 cursor-pointer accent-primary md:h-8" />
      <output htmlFor={inputId} className="w-16 shrink-0 truncate text-right text-xs tabular-nums text-text-subtle">{value}</output>
    </div>
  );
}

function ColorControl({ def, value, onChange, inputId }: ControlProps<ColorTweak>) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const invalid = !COLOR_VALUE_RE.test(text.trim());
  return (
    <div className="flex items-center gap-2">
      <input id={inputId} type="color" value={hexForColorInput(value, def.default)} onChange={(e) => onChange(e.target.value)}
        className="h-11 w-14 shrink-0 cursor-pointer rounded-md border border-border bg-transparent p-1 md:h-8" />
      <Input value={text} aria-label={`${def.label} hex value`} aria-invalid={invalid} spellCheck={false} maxLength={9}
        onChange={(e) => {
          setText(e.target.value);
          const next = e.target.value.trim();
          if (COLOR_VALUE_RE.test(next)) onChange(next);
        }}
        className="h-11 font-mono md:h-8" />
    </div>
  );
}

function SelectControl({ def, value, onChange, inputId }: ControlProps<SelectTweak>) {
  const known = def.options.some((o) => o.value === value);
  return (
    <select id={inputId} value={known ? value : ""} onChange={(e) => onChange(e.target.value)}
      className="h-11 w-full rounded-lg border border-border bg-surface px-2 text-base text-foreground md:h-8 md:text-sm">
      {!known && <option value="" disabled>{value ? `Current: ${value}` : "Choose…"}</option>}
      {def.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

export function TweakControl({ def, value, winner, overridden, onChange }: {
  def: TweakDef;
  value: string;
  winner?: TweakWinner;
  overridden: boolean;
  onChange: (value: string) => void;
}) {
  const inputId = useId();
  const note = overridden
    ? "A later or more specific rule overrides this tweak, so the page does not show the applied value."
    : winner === "conditional"
      ? "This variable is set last inside a conditional rule; Apply may not be able to change it."
      : null;
  return (
    <div className="flex flex-col gap-1 px-3 py-2">
      <label htmlFor={inputId} className="flex items-baseline gap-2 text-sm">
        <span className="min-w-0 flex-1 truncate">{def.label}</span>
        <code className="shrink-0 text-[11px] text-text-subtle">{def.var}</code>
      </label>
      {def.type === "range" && <RangeControl def={def} value={value} onChange={onChange} inputId={inputId} />}
      {def.type === "color" && <ColorControl def={def} value={value} onChange={onChange} inputId={inputId} />}
      {def.type === "select" && <SelectControl def={def} value={value} onChange={onChange} inputId={inputId} />}
      {note && (
        <p className="flex items-start gap-1 text-xs leading-relaxed text-warning">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" /> {note}
        </p>
      )}
    </div>
  );
}
