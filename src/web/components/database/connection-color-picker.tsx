import { cn } from "@/lib/utils";

const COLOR_PRESETS = [
  "#ef4444", "#f97316", "#eab308", "#22c55e",
  "#06b6d4", "#3b82f6", "#8b5cf6", "#ec4899",
  "#6b7280", "#000000",
];

interface ConnectionColorPickerProps {
  value: string | null;
  onChange: (color: string | null) => void;
}

export function ConnectionColorPicker({ value, onChange }: ConnectionColorPickerProps) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {/* No color option */}
        <button
          type="button"
          onClick={() => onChange(null)}
          className={cn(
            "size-6 rounded-full border-2 transition-all",
            !value ? "border-primary scale-110" : "border-border hover:scale-105",
            "bg-transparent relative",
          )}
          title="No color"
        >
          <span className="absolute inset-0 flex items-center justify-center text-[8px] text-text-subtle">×</span>
        </button>
        {/* Preset colors */}
        {COLOR_PRESETS.map((color) => (
          <button
            key={color}
            type="button"
            onClick={() => onChange(color)}
            className={cn(
              "size-6 rounded-full border-2 transition-all hover:scale-105",
              value === color ? "border-primary scale-110" : "border-transparent",
            )}
            style={{ backgroundColor: color }}
            title={color}
          />
        ))}
      </div>
      {/* Custom hex input */}
      <div className="flex items-center gap-2">
        <div
          className="size-6 rounded-full border border-border shrink-0"
          style={{ backgroundColor: value ?? "transparent" }}
        />
        <input
          type="text"
          value={value ?? ""}
          onChange={(e) => {
            const v = e.target.value.trim();
            if (v === "") { onChange(null); return; }
            if (/^#[0-9a-fA-F]{6}$/.test(v)) onChange(v);
            else onChange(v); // allow partial typing
          }}
          placeholder="#3b82f6"
          className="flex-1 h-7 text-xs px-2 rounded-md border border-border bg-background focus:outline-none focus:border-primary font-mono"
        />
      </div>
    </div>
  );
}
