/**
 * The connection form's small parts, so every field is sized and spoken for the same way.
 *
 * Touch sizes follow the viewport (`md:`), the phone rule; how many columns the form has follows
 * the form's own width (`@container` in the tab), since a narrow split panel is not a phone.
 */
import { forwardRef, useState, type ReactNode } from "react";
import { ChevronDown, Eye, EyeOff } from "@/lib/icons";
import { FileBrowserPicker } from "@/components/ui/file-browser-picker";
import { cn } from "@/lib/utils";
import type { HelpLine } from "./connection-form-state";

export const inputClass =
  "h-11 md:h-[30px] w-full min-w-0 rounded-md border border-border bg-surface px-2.5 text-base md:text-[13px] text-text-primary placeholder:text-text-subtle focus:outline-none focus:border-ring disabled:cursor-not-allowed disabled:opacity-55 aria-invalid:border-error";

export function Help({ line, id }: { line: HelpLine | null; id?: string }) {
  if (!line || !line.text) return null;
  return (
    <p
      id={id}
      className={cn(
        "text-[12.5px] md:text-[11.5px] leading-snug break-words",
        line.tone === "bad" ? "text-error" : line.tone === "ok" ? "text-success" : "text-text-subtle",
      )}
    >
      {line.text}
    </p>
  );
}

/** A labelled field: the label above, the control, then its error and its help. */
export function Field({
  label, htmlFor, labelId, optional, error, help, className, children,
}: {
  label: ReactNode;
  /** The control the label names; `labelId` instead for a group that has no single control. */
  htmlFor?: string;
  labelId?: string;
  optional?: boolean;
  error?: string | null;
  help?: HelpLine | string | null;
  className?: string;
  children: ReactNode;
}) {
  const Label = htmlFor ? "label" : "span";
  const helpLine = typeof help === "string" ? { tone: "plain" as const, text: help } : help ?? null;
  return (
    <div className={cn("grid content-start gap-[5px] min-w-0", className)}>
      <Label htmlFor={htmlFor} id={labelId} className="text-[13px] md:text-xs font-medium text-text-2">
        {label}
        {optional && <span className="ml-1 font-normal text-text-subtle">optional</span>}
      </Label>
      {children}
      {error && <Help id={htmlFor && `${htmlFor}-error`} line={{ tone: "bad", text: error }} />}
      <Help line={helpLine} />
    </div>
  );
}

type TextInputProps = React.InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean; mono?: boolean };

export const TextInput = forwardRef<HTMLInputElement, TextInputProps>(function TextInput(
  { invalid, mono, className, id, ...props }, ref,
) {
  return (
    <input
      ref={ref}
      id={id}
      autoComplete="off"
      autoCapitalize="off"
      spellCheck={false}
      aria-invalid={invalid || undefined}
      aria-describedby={invalid && id ? `${id}-error` : undefined}
      className={cn(inputClass, mono && "font-mono", className)}
      {...props}
    />
  );
});

/** A password box with the eye button that shows what was typed. */
export const PasswordInput = forwardRef<HTMLInputElement, Omit<TextInputProps, "type" | "mono">>(function PasswordInput(
  { className, disabled, ...props }, ref,
) {
  const [shown, setShown] = useState(false);
  return (
    <div className="relative flex min-w-0">
      <TextInput
        ref={ref}
        type={shown ? "text" : "password"}
        autoComplete="new-password"
        disabled={disabled}
        className={cn("pr-11 md:pr-8", className)}
        {...props}
      />
      <button
        type="button"
        disabled={disabled}
        onClick={() => setShown((s) => !s)}
        aria-label={shown ? "Hide password" : "Show password"}
        aria-pressed={shown}
        className="absolute right-0 top-0 grid h-full w-11 md:w-8 place-items-center text-text-subtle can-hover:hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-55"
      >
        {shown ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
      </button>
    </div>
  );
});

/** A file on the PPM host: typed, or picked with Browse…, which browses the host and not this device. */
export const PathInput = forwardRef<HTMLInputElement, Omit<TextInputProps, "mono" | "accept"> & {
  onPick: (path: string) => void;
  pickerTitle: string;
  /** Where Browse… opens; the folder of the path already typed wins. */
  pickerRoot?: string;
  accept?: string[];
}>(function PathInput({ onPick, pickerTitle, pickerRoot, accept, disabled, value, ...props }, ref) {
  const [browsing, setBrowsing] = useState(false);
  const typed = typeof value === "string" ? value.trim() : "";
  const folder = typed.includes("/") || typed.includes("\\") ? typed.replace(/[\\/][^\\/]*$/, "") || "/" : "";
  return (
    <>
      <div className="flex min-w-0 gap-2">
        <TextInput ref={ref} mono disabled={disabled} value={value} {...props} />
        <button
          type="button"
          disabled={disabled}
          onClick={() => setBrowsing(true)}
          className="shrink-0 h-11 md:h-[30px] rounded-md border border-border bg-surface px-3 text-[14px] md:text-[12.5px] text-text-primary can-hover:hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-55"
        >
          Browse…
        </button>
      </div>
      <FileBrowserPicker
        open={browsing}
        mode="file"
        accept={accept}
        root={folder || pickerRoot}
        title={pickerTitle}
        onSelect={(path) => { onPick(path); setBrowsing(false); }}
        onCancel={() => setBrowsing(false)}
      />
    </>
  );
});

/** A native select: the phone's own picker below `md`, as the mobile rules ask. */
export const SelectInput = forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(function SelectInput(
  { className, children, ...props }, ref,
) {
  return (
    <span className="relative flex min-w-0">
      <select ref={ref} className={cn(inputClass, "appearance-none pr-8 cursor-pointer", className)} {...props}>
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2 top-1/2 size-3.5 -translate-y-1/2 text-text-subtle" />
    </span>
  );
});

/** A checkbox with a bold title and a line under it saying what it does. */
export function CheckRow({
  id, checked, disabled, onChange, title, help, className,
}: {
  id: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
  title: ReactNode;
  help?: ReactNode;
  className?: string;
}) {
  return (
    <label
      htmlFor={id}
      className={cn(
        "flex items-start gap-[9px] min-w-0 min-h-11 md:min-h-0 py-1.5 md:py-0 text-[14.5px] md:text-[12.5px] text-text-primary",
        disabled ? "cursor-not-allowed" : "cursor-pointer",
        className,
      )}
    >
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-px size-5 md:size-[15px] shrink-0 accent-primary disabled:opacity-55"
      />
      <span className="min-w-0">
        <b className={cn("block font-medium", disabled && "text-text-subtle")}>{title}</b>
        {help && <small className="mt-px block text-[12.5px] md:text-[11.5px] text-text-subtle">{help}</small>}
      </span>
    </label>
  );
}

export function RadioRow({
  name, value, checked, onChange, children,
}: {
  name: string;
  value: string;
  checked: boolean;
  onChange: (value: string) => void;
  children: ReactNode;
}) {
  return (
    <label className="flex items-center gap-[9px] min-h-11 md:min-h-0 text-[14.5px] md:text-[12.5px] text-text-primary cursor-pointer">
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        onChange={() => onChange(value)}
        className="size-5 md:size-[15px] shrink-0 accent-primary"
      />
      <span>{children}</span>
    </label>
  );
}
