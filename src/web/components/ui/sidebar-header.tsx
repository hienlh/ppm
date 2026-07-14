import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

interface SidebarHeaderProps {
  icon: LucideIcon;
  title: string;
  children?: ReactNode;
}

export function SidebarHeader({ icon: Icon, title, children }: SidebarHeaderProps) {
  return (
    <div className="flex items-center gap-1 px-2 py-2 border-b border-border shrink-0">
      <Icon className="size-4 text-primary" />
      <span className="text-xs font-semibold uppercase tracking-wide text-text-secondary flex-1">{title}</span>
      {children}
    </div>
  );
}
