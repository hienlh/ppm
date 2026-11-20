/**
 * What runs beside this chat, as the first chip of the footer's context row: the agents it
 * launched and the sessions linked to it, in one chip with one popover of two tabs.
 *
 * The chip carries one status dot for everything — pulsing green while an agent or a linked session
 * runs, red while a linked session waits on the person, blue while one has an answer not yet read,
 * grey once all of it is idle — then
 * "[bot] 2 agents │ [link] 3 linked". A part that is zero is left out, and with neither there is
 * no chip at all. It turns red-tinted only when something needs the person.
 *
 * The popover opens on the tab that needs attention: Sessions when a session waits on the person,
 * else Agents while one runs, else Tasks while the CLI runs background work, else Sessions. The
 * Agents tab exists only while an agent runs, the Tasks tab only while a background task does —
 * each task (a shell, an agent, a monitor, a workflow) with its own Stop, sent straight to the CLI.
 */
import { useEffect, useRef, useState } from "react";
import { Bot, ChevronRight, Layers, Link, Loader2, Square } from "@/lib/icons";
import { taskKindLabel, type LiveBackgroundTask } from "../../../shared/background-tasks";
import { cn } from "@/lib/utils";
import { useRunningAgents, type AgentView } from "@/hooks/use-running-agents";
import { useLinkedSessionGroups } from "@/hooks/use-linked-sessions";
import type { TeamMemberActivity } from "@/hooks/use-team-activity-feed";
import type { ChatMessage } from "../../../types/chat";
import type { AgentTranscriptProviderId } from "../../../shared/agent-transcript-protocol";
import { LinkedStatusDot } from "./linked-session-chip";
import { LinkedSessionsPanel } from "./linked-sessions-panel";
import { FooterPopover } from "./footer-popover";
import { FOOTER_CHIP, HIDE_NARROW } from "./footer-chip";

type Tab = "agents" | "tasks" | "sessions";

export function ActivityChip({ projectName, agentProviderId, sessionId, messages, teamName, teamMembers, liveTasks = [], onStopTask, yieldNarrow = false }: {
  projectName: string;
  /** The provider whose agent transcripts feed the Agents tab. */
  agentProviderId: AgentTranscriptProviderId;
  sessionId: string | null;
  messages: ChatMessage[];
  /** The session's implicit team name, for a teammate row's source. */
  teamName: string;
  teamMembers: TeamMemberActivity[];
  /** The CLI's background tasks right now, and how to stop one. */
  liveTasks?: LiveBackgroundTask[];
  onStopTask?: (taskId: string) => void;
  /**
   * Leave the row whole when the chat is narrow, so a chip that matters more (the manager chat's
   * Tasks chip) keeps its place: off by default, so other chats are unchanged. Never while a
   * linked session needs the user: in a manager chat this chip is the only sign of that.
   */
  yieldNarrow?: boolean;
}) {
  const agents = useRunningAgents({ projectName, providerId: agentProviderId, sessionId, messages, teamName, teamMembers });
  const groups = useLinkedSessionGroups(projectName, sessionId, messages);
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("sessions");
  /** The tab was switched by the person, not picked on open: only then does it slide. */
  const [switched, setSwitched] = useState(false);
  const chipRef = useRef<HTMLButtonElement>(null);

  const linked = groups.visible;
  const needsYou = linked.some((l) => l.status === "needs_approval");
  const sessionsRunning = linked.some((l) => l.status === "running");
  const hasAgents = agents.running > 0;
  const hasTasks = liveTasks.length > 0;
  // Hidden sessions keep the chip, so they can still be found and relinked.
  const hasSessions = linked.length > 0 || groups.hidden.length > 0;
  const visible = !!sessionId && (hasAgents || hasTasks || hasSessions);
  // A chip that went away takes its popover with it: when the next agent starts the chip comes
  // back closed, rather than with a popover (or a sheet over the chat) nobody asked for.
  useEffect(() => { if (!visible) setOpen(false); }, [visible]);
  if (!sessionId || !visible) return null;

  const unread = linked.some((l) => l.status === "new_message");
  const dot = needsYou ? "needs_approval" : hasAgents || hasTasks || sessionsRunning ? "running" : unread ? "new_message" : "idle";
  const shown: Tab = (tab === "agents" && hasAgents) || (tab === "tasks" && hasTasks) ? tab : "sessions";
  const toggle = () => {
    if (open) { setOpen(false); return; }
    // Open where attention is: a session that needs you, else running agents, else sessions.
    setTab(needsYou ? "sessions" : hasAgents ? "agents" : hasTasks ? "tasks" : "sessions");
    setSwitched(false);
    setOpen(true);
  };
  const pick = (next: Tab) => { setTab(next); setSwitched(true); };

  const title = [
    hasAgents ? `${agents.running} ${agents.running === 1 ? "agent" : "agents"} running` : null,
    hasTasks ? liveTasks.length + (liveTasks.length === 1 ? " background task" : " background tasks") : null,
    hasSessions ? `${linked.length} linked` : null,
    needsYou ? "one needs you" : null,
  ].filter(Boolean).join(" · ");

  return (
    <>
      <button
        ref={chipRef}
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={title}
        aria-label={title}
        data-activity-chip=""
        data-activity-dot={dot}
        className={cn(FOOTER_CHIP, "gap-[7px] @max-[420px]/chat:gap-[5px] max-md:gap-[5px]", needsYou && "border-error/35 can-hover:hover:border-error/60", yieldNarrow && !needsYou && "@max-[340px]/chat:hidden")}
      >
        <LinkedStatusDot status={dot} />
        {hasAgents && (
          <span className="inline-flex items-center gap-1" data-activity-part="agents">
            <Bot className="text-text-3" />
            <b className="font-medium tabular-nums text-text">{agents.running}</b>
            <span className={HIDE_NARROW}>{agents.running === 1 ? "agent" : "agents"}</span>
          </span>
        )}
        {hasAgents && hasTasks && <span className="h-3 w-px shrink-0 bg-border" aria-hidden="true" />}
        {hasTasks && (
          <span className="inline-flex items-center gap-1" data-activity-part="tasks">
            <Layers className="text-text-3" />
            <b className="font-medium tabular-nums text-text">{liveTasks.length}</b>
            <span className={HIDE_NARROW}>{liveTasks.length === 1 ? "task" : "tasks"}</span>
          </span>
        )}
        {(hasAgents || hasTasks) && hasSessions && <span className="h-3 w-px shrink-0 bg-border" aria-hidden="true" />}
        {hasSessions && (
          <span className="inline-flex items-center gap-1" data-activity-part="sessions">
            <Link className="text-text-3" />
            <b className="font-medium tabular-nums text-text">{linked.length}</b>
            <span className={HIDE_NARROW}>linked</span>
            {needsYou && <span className={cn("text-error", HIDE_NARROW)}>· needs you</span>}
          </span>
        )}
      </button>

      <FooterPopover open={open} onClose={() => setOpen(false)} label="Agents, background tasks and linked sessions" anchorRef={chipRef}>
        <div role="tablist" aria-label="Activity" className="flex shrink-0 gap-0.5 border-b border-border-soft p-1.5">
          {hasAgents && (
            <TabButton active={shown === "agents"} onClick={() => pick("agents")} icon={<Bot />} label="Agents" count={agents.running} />
          )}
          {hasTasks && (
            <TabButton active={shown === "tasks"} onClick={() => pick("tasks")} icon={<Layers />} label="Tasks" count={liveTasks.length} />
          )}
          <TabButton active={shown === "sessions"} onClick={() => pick("sessions")} icon={<Link />} label="Sessions" count={linked.length} alert={needsYou} />
        </div>
        {shown === "agents" ? (
          <div key="agents" role="tabpanel" aria-label="Agents" className={cn("flex min-h-0 flex-1 flex-col", switched && "footer-from-left")}>
            <AgentList agents={agents.views} onOpen={(v) => { setOpen(false); agents.openView(v); }} />
          </div>
        ) : shown === "tasks" ? (
          <div key="tasks" role="tabpanel" aria-label="Tasks" className={cn("flex min-h-0 flex-1 flex-col", switched && "footer-from-right")}>
            <TaskList tasks={liveTasks} onStop={onStopTask} />
          </div>
        ) : (
          <div key="sessions" role="tabpanel" aria-label="Sessions" className={cn("flex min-h-0 flex-1 flex-col", switched && "footer-from-right")}>
            <LinkedSessionsPanel projectName={projectName} sessionId={sessionId} groups={groups} onOpened={() => setOpen(false)} />
          </div>
        )}
      </FooterPopover>
    </>
  );
}

function TabButton({ active, onClick, icon, label, count, alert }: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  count: number;
  alert?: boolean;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      data-activity-tab={label.toLowerCase()}
      className={cn(
        "relative inline-flex h-[30px] flex-1 items-center justify-center gap-1.5 rounded-[7px] text-xs font-medium transition-[background-color,color] duration-150 max-md:h-11 max-md:text-sm [&_svg]:size-3.5 [&_svg]:text-text-3",
        active ? "bg-panel text-text shadow-[0_0_0_1px_var(--border-soft),0_1px_2px_rgb(0_0_0/0.06)]" : "text-text-2 can-hover:hover:bg-surface-hover can-hover:hover:text-text",
      )}
    >
      {icon}
      {label}
      <span className="text-[11px] tabular-nums text-text-3">{count}</span>
      {alert && <span className="size-1.5 rounded-full bg-error" aria-label="needs you" />}
    </button>
  );
}

/** Running agents, then the finished ones launched beside them; a tap opens that agent's session. */
function AgentList({ agents, onOpen }: { agents: AgentView[]; onOpen: (v: AgentView) => void }) {
  return (
    <ul className="max-h-[220px] min-h-0 list-none overflow-y-auto overscroll-contain p-1 max-md:max-h-none max-md:flex-1">
      {agents.map((v) => (
        <li key={v.row.key}>
          <button
            type="button"
            onClick={() => onOpen(v)}
            title={`Open ${v.name}'s session`}
            data-agent-row={v.row.key}
            className="flex min-h-11 w-full items-center gap-2.5 rounded-md px-2 py-1 text-left text-text transition-[background-color,transform] duration-150 motion-safe:active:scale-[0.97] can-hover:hover:bg-surface-hover"
          >
            <LinkedStatusDot status={v.row.done ? "idle" : "running"} />
            <span className="flex min-w-0 flex-1 flex-col gap-px">
              <span className={cn("truncate text-[13px] font-medium", v.row.done && "text-text-2")}>{v.name}</span>
              <span className={cn("truncate font-mono text-[11px]", v.row.failed ? "text-error" : "text-text-3")}>
                {v.row.failed ? "Failed" : v.row.done ? "Finished" : v.step ?? "Starting…"}
              </span>
            </span>
            {!!v.elapsed && <span className="shrink-0 font-mono text-[11px] text-text-3">{v.elapsed}</span>}
            <ChevronRight className="size-3 shrink-0 text-text-3" />
          </button>
        </li>
      ))}
    </ul>
  );
}

/** The CLI's background tasks; Stop asks the CLI to end one, and the row goes once it has. */
function TaskList({ tasks, onStop }: { tasks: LiveBackgroundTask[]; onStop?: (taskId: string) => void }) {
  const [stopping, setStopping] = useState<ReadonlySet<string>>(new Set());
  return (
    <ul className="max-h-[220px] min-h-0 list-none overflow-y-auto overscroll-contain p-1 max-md:max-h-none max-md:flex-1">
      {tasks.map((t) => {
        const busy = stopping.has(t.taskId);
        return (
          <li key={t.taskId} data-background-task={t.taskId} className="flex min-h-11 items-center gap-2.5 rounded-md px-2 py-1 text-text">
            <LinkedStatusDot status="running" />
            <span className="flex min-w-0 flex-1 flex-col gap-px">
              <span className="truncate text-[13px] font-medium" title={t.description}>{t.description || t.taskId}</span>
              <span className="truncate font-mono text-[11px] text-text-3">{busy ? "Stopping…" : taskKindLabel(t)}</span>
            </span>
            {onStop && (
              <button
                type="button"
                disabled={busy}
                onClick={() => { setStopping((prev) => new Set(prev).add(t.taskId)); onStop(t.taskId); }}
                aria-label={"Stop " + (t.description || "task")}
                title="Stop"
                data-stop-task={t.taskId}
                className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-text-2 transition-colors max-md:size-[26px] can-hover:hover:bg-surface-hover can-hover:hover:text-error disabled:opacity-50"
              >
                {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Square className="size-3.5" />}
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
