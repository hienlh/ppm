/**
 * The bordered sections Settings → PPM Assistant is laid out in: a header with an icon, a title
 * and an optional hint or control on the right, then rows. A row puts its label on the left and
 * its controls on the right once the pane is wide enough, and stacks them below that — by the
 * pane's own width (`@container` on the section), never the viewport's.
 */
import type { ElementType, ReactNode } from "react";
import { cn } from "@/lib/utils";

export function SettingsCard({ icon: Icon, title, aside, children, testId }: {
  icon: ElementType;
  title: string;
  /** A hint or control on the header's right. */
  aside?: ReactNode;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <section className="overflow-hidden rounded-xl border border-border bg-panel-2" data-testid={testId}>
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border-soft px-3.5 py-3 text-sm font-semibold">
        <Icon className="size-4 shrink-0 text-text-secondary" />
        <h3>{title}</h3>
        {aside && <div className="ml-auto flex items-center gap-2 text-xs font-normal text-text-subtle">{aside}</div>}
      </header>
      <div className="divide-y divide-border-soft">{children}</div>
    </section>
  );
}

export function SettingLine({ label, note, children, className }: {
  label: ReactNode;
  note?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex min-h-[52px] flex-col gap-2 px-3.5 py-2.5 @[520px]:flex-row @[520px]:items-center @[520px]:gap-3", className)}>
      <div className="min-w-0 flex-1 text-sm">
        {label}
        {note && <small className="mt-0.5 block text-xs leading-snug text-text-subtle">{note}</small>}
      </div>
      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
    </div>
  );
}
