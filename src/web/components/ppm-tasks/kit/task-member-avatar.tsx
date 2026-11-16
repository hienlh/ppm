/**
 * A person as a round avatar with initials, tinted by one of five tones that stays the same for the
 * member everywhere. "You" is neutral; an AI actor gets the accent gradient.
 */
import { cn } from "@/lib/utils";
import { memberInitials, memberTone } from "@/lib/ppm-tasks/ppm-tasks-kit-logic";
import { ME_MEMBER_ID } from "../../../../shared/ppm-tasks";

const TONES = ["var(--accent)", "var(--accent-2)", "var(--info)", "var(--success)", "var(--error)"];
const SIZE = { sm: "size-[18px] text-[8.5px]", md: "size-[22px] text-[9.5px]", lg: "size-7 text-[11px]" } as const;

export interface TaskMemberAvatarProps {
  name: string;
  /** The member id; `me` is the user. Without one the name picks the tone. */
  memberId?: string | null;
  ai?: boolean;
  size?: keyof typeof SIZE;
  showName?: boolean;
  className?: string;
}

export function TaskMemberAvatar({ name, memberId, ai = false, size = "md", showName = false, className }: TaskMemberAvatarProps) {
  const tone = memberId === ME_MEMBER_ID ? "var(--text-2)" : TONES[memberTone(memberId ?? name) - 1]!;
  const style = ai
    ? { color: "var(--accent-foreground)", background: "linear-gradient(135deg, var(--accent), var(--accent-2))" }
    : { color: tone, background: `color-mix(in srgb, ${tone} 18%, transparent)` };
  const avatar = (
    <span className={cn("inline-grid shrink-0 place-items-center rounded-full font-semibold", SIZE[size], !showName && className)} style={style}
      title={showName ? undefined : name} aria-label={showName ? undefined : name}>
      {memberInitials(name)}
    </span>
  );
  if (!showName) return avatar;
  return (
    <span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap text-xs", className)}>
      {avatar}
      <span className="truncate">{name}</span>
    </span>
  );
}
