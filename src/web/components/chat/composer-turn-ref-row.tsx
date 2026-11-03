/**
 * The composer's turn chips, above the input, and why the send waits when it does. The chips
 * warn when `read_session_turns` is off: the message still sends, but the AI will only see that
 * a turn was referenced, not what was in it.
 */
import type { ComposerTurnChip } from "@/hooks/use-composer-turn-refs";
import { useReadSessionTurnsOn } from "@/hooks/use-read-session-turns-on";
import { TurnRefChip } from "./turn-ref-chip";

export function ComposerTurnRefRow({ chips, currentProject, blockedReason, onRemove }: {
  chips: readonly ComposerTurnChip[];
  currentProject?: string;
  blockedReason?: string | null;
  onRemove: (key: string) => void;
}) {
  const toolOn = useReadSessionTurnsOn();
  return (
    <div className="px-2 pt-2 md:px-4">
      <div className="flex flex-wrap gap-2" data-composer-turn-refs="">
        {chips.map((chip) => (
          <TurnRefChip key={chip.key} chip={chip} currentProject={currentProject} toolsOff={!toolOn} onRemove={() => onRemove(chip.key)} />
        ))}
      </div>
      {blockedReason && <p role="status" className="mt-1 text-xs text-text-subtle">{blockedReason}</p>}
    </div>
  );
}
