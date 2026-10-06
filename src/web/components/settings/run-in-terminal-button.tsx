import { TerminalSquare } from "@/lib/icons";
import { Button } from "@/components/ui/button";
import { runInTerminal } from "@/lib/run-in-terminal";

/**
 * Types a command into a PPM terminal and leaves it there for the person to run.
 *
 * For the setup steps PPM cannot take itself: ones that need the host's password (`sudo`) or
 * run a system package manager, which PPM never does on anyone's behalf. The terminal's shell
 * runs on the host, so this works from a phone as well. Nothing runs until Enter is pressed:
 * the command arrives with no newline, the same as every other "send to terminal" in PPM.
 *
 * `onRun` fires first, for a caller inside a modal dialog: the terminal opens in the dock behind
 * it, where it cannot be typed into until the dialog is out of the way.
 */
export function RunInTerminalButton({ command, label, onRun, variant = "default" }: {
  command: string;
  label: string;
  onRun?: () => void;
  variant?: "default" | "outline";
}) {
  return (
    <Button
      variant={variant}
      title={command}
      onClick={() => { onRun?.(); runInTerminal(command); }}
      className="min-h-11 cursor-pointer md:min-h-9"
    >
      <TerminalSquare className="size-4" />{label}
    </Button>
  );
}
