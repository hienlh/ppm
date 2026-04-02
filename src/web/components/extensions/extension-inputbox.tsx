import { useState, useEffect, useRef } from "react";
import { useExtensionStore } from "@/stores/extension-store";

/** Modal overlay for extension-driven InputBox prompt */
export function ExtensionInputBox() {
  const inputBox = useExtensionStore((s) => s.inputBox);
  const resolveInputBox = useExtensionStore((s) => s.resolveInputBox);

  if (!inputBox) return null;

  return (
    <InputBoxModal
      options={inputBox.options}
      onConfirm={(value) => resolveInputBox(value)}
      onCancel={() => resolveInputBox(undefined)}
    />
  );
}

function InputBoxModal({
  options,
  onConfirm,
  onCancel,
}: {
  options: { prompt?: string; value?: string; placeholder?: string; password?: boolean };
  onConfirm: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(options.value ?? "");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  }, []);

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      onConfirm(value);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end md:items-start justify-center md:pt-[20vh]" onClick={onCancel}>
      <div className="fixed inset-0 bg-black/50" />
      <div
        className="relative z-10 w-full max-w-md rounded-t-xl md:rounded-xl border border-border bg-background shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Prompt */}
        {options.prompt && (
          <div className="px-3 pt-3 pb-1 text-sm text-text-primary">{options.prompt}</div>
        )}

        {/* Input */}
        <div className="flex items-center gap-2 px-3 py-2.5">
          <input
            ref={inputRef}
            type={options.password ? "password" : "text"}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={options.placeholder ?? ""}
            className="flex-1 bg-surface border border-border rounded px-2 py-1.5 text-sm text-text-primary outline-none focus:border-primary placeholder:text-text-subtle"
          />
        </div>

        {/* Actions */}
        <div className="flex items-center justify-end gap-2 border-t border-border px-3 py-2">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary transition-colors rounded"
          >
            Cancel
          </button>
          <button
            onClick={() => onConfirm(value)}
            className="px-3 py-1.5 text-xs bg-primary text-primary-foreground rounded hover:bg-primary/90 transition-colors font-medium"
          >
            OK
          </button>
        </div>
      </div>
    </div>
  );
}
