import { useRef, useState } from "react";
import { Send } from "lucide-react";
import { Button } from "../ui/button";
import { cn } from "../../lib/utils";

interface MessageInputProps {
  onSend: (content: string) => void;
  disabled?: boolean;
}

export function MessageInput({ onSend, disabled }: MessageInputProps) {
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const submit = () => {
    const trimmed = value.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setValue("");
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setValue(e.target.value);
    const el = e.target;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  };

  return (
    <div className="border-t border-border px-2 py-2 shrink-0">
      <div className={cn(
        "flex items-end gap-2 rounded-xl border border-border bg-muted/40 px-3 py-2",
        disabled && "opacity-60",
      )}>
        <textarea
          ref={textareaRef}
          rows={1}
          value={value}
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          disabled={disabled}
          placeholder="Message..."
          className="flex-1 resize-none bg-transparent text-sm outline-none placeholder:text-muted-foreground min-h-[24px] max-h-[160px]"
        />
        <Button
          size="icon"
          className="size-7 shrink-0"
          onClick={submit}
          disabled={disabled || !value.trim()}
        >
          <Send className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}
