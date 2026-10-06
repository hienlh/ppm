import { useEffect, useRef, type ElementType } from "react";

/**
 * A folder's name typed where the folder is, as DBGate's tree does it: Enter or leaving the field
 * keeps it, Escape leaves it as it was.
 */
export function FolderNameInput({ initial, icon: Icon, label, onCommit, onCancel }: {
  initial: string;
  icon: ElementType;
  label: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const finish = (commit: boolean) => {
    if (done.current) return;
    done.current = true;
    if (commit) onCommit(ref.current?.value ?? "");
    else onCancel();
  };

  return (
    <div role="none" className="mx-1 flex h-[26px] items-center gap-[5px] pr-1.5 pl-0.5 max-md:mx-1.5 max-md:h-11 max-md:gap-[7px] max-md:pl-1.5">
      <span className="w-4 shrink-0" />
      <Icon className="size-[15px] shrink-0 text-text-subtle" />
      <input ref={ref} defaultValue={initial} aria-label={label} placeholder="Folder name" autoComplete="off" spellCheck={false}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); finish(true); }
          else if (e.key === "Escape") { e.preventDefault(); finish(false); }
        }}
        onBlur={() => finish(true)}
        className="h-[22px] min-w-0 flex-1 rounded border border-primary bg-input px-1.5 text-[13px] font-medium text-foreground outline-none max-md:h-9 max-md:text-[15px]" />
    </div>
  );
}
