/**
 * The fields the chat's quick view edits, drawn compact: status, urgency, importance, assignee,
 * waiting on and due as one wrapping row of chips, then the next step folded to two lines.
 *
 * A press on a chip edits that field where it is: the five pickers open a small menu of the task
 * page's own choices (`statusChoices`… in `task-property-fields.tsx`) and save on the pick; Due
 * opens the browser's date picker. So every edit the task page's fields allow is still here. An
 * empty field keeps a faint dashed chip, the place to set it. The due date and the next step save
 * when the field is left, and also when the quick view closes or moves to another task while they
 * hold something unsaved, so nothing typed is lost.
 *
 * The menus are not modal: a press elsewhere in the quick view only closes the menu, and the
 * quick view leaves a press or an Escape inside a Radix menu to the menu (`task-peek-popover.tsx`).
 *
 * On a phone a chip is drawn 32px and takes presses 6px above and below it, a 44px target, with
 * the rows 12px apart so neighbouring targets do not overlap; a menu row is 44px
 * (docs/design-guidelines.md, rule 3).
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Calendar, Clock, Hand, UserPlus } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { IMPORTANCE_LABEL, URGENCY_LABEL, dueView, localYmd } from "@/lib/ppm-tasks/ppm-tasks-kit-logic";
import { peekChipTitle, peekMemberName } from "@/lib/ppm-tasks/task-peek-compact";
import { PPM_TASK_LIMITS, type Importance, type TaskPatch, type Urgency } from "../../../../shared/ppm-tasks";
import type { TaskDto, TaskProjectSettings } from "../../../../shared/ppm-tasks-api";
import { isSaveableDate } from "../task-date-input";
import { useSavedDraft } from "../use-saved-draft";
import { TaskProp, importanceChoices, memberChoices, statusChoices, taskPeople, urgencyChoices, type TaskChoice } from "../task-property-fields";
import { TaskStatusGlyph } from "../kit/task-status-glyph";
import { URGENCY_TONE } from "../kit/task-urgency-pill";
import { TaskImportanceBars } from "../kit/task-importance-bars";
import { TaskMemberAvatar } from "../kit/task-member-avatar";
import { TaskDueLabel } from "../kit/task-due-label";

/** A chip: 28px, 32px on a phone; a set field solid, an empty one faint and dashed. */
const CHIP = cn(
  "relative inline-flex h-7 min-h-0! min-w-0! max-w-full shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border px-2 text-[12px] outline-none transition-colors",
  "max-md:h-8 max-md:text-[13px] focus-visible:border-ring can-hover:hover:border-border can-hover:hover:bg-surface-hover",
);
const SET = "border-border-soft bg-surface text-text";
const EMPTY = "border-dashed border-border-soft text-text-3";
/** On a phone a chip button takes presses 6px above and below it: a 44px target. */
const PHONE_REACH = "max-md:after:absolute max-md:after:inset-x-0 max-md:after:-inset-y-1.5 max-md:after:content-['']";
/**
 * Due's date input over its chip: invisible, the chip's whole size and on a phone 6px more above
 * and below. 16px text, or iOS zooms the page when it takes focus.
 */
const OVERLAY = "absolute inset-x-0 top-0 h-full w-full min-h-0! cursor-pointer appearance-none border-0 p-0 text-[16px] opacity-0 max-md:-top-1.5 max-md:h-[calc(100%+12px)]";
/** A menu row: the app's menu row, 44px on a phone. */
const MENU_ROW = "gap-2 text-[13px] max-md:min-h-11 max-md:text-[15px]";

type ChipField = "status" | "urgency" | "importance" | "assignee" | "waiting" | "due";

/**
 * A chip whose press opens a menu of the field's choices, the current one marked; picking another
 * calls `onChange` (picking the current one changes nothing).
 */
function MenuChip({ field, label, value, title, empty, choices, renderChoice, onChange, children }: {
  field: ChipField; label: string; value: string; title: string; empty?: boolean; choices: readonly TaskChoice[];
  renderChoice?(choice: TaskChoice): ReactNode; onChange(value: string): void; children: ReactNode;
}) {
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button type="button" aria-label={title} title={title} data-task-peek-chip={field} data-empty={empty || undefined}
          className={cn(CHIP, PHONE_REACH, empty ? EMPTY : SET, "data-[state=open]:border-ring data-[state=open]:bg-surface-hover")}>
          {children}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" aria-label={label} data-task-peek-menu={field} className="max-h-72 min-w-[11rem]">
        <DropdownMenuRadioGroup value={value} onValueChange={(v) => { if (v !== value) onChange(v); }}>
          {choices.map((c) => (
            <DropdownMenuRadioItem key={c.value} value={c.value} className={MENU_ROW} data-task-peek-choice={c.value}>
              {renderChoice ? renderChoice(c) : c.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Due's chip: a label over the date input, which takes the presses. */
function Chip({ field, title, empty, children }: { field: ChipField; title: string; empty: boolean; children: ReactNode }) {
  return (
    <label className={cn(CHIP, "focus-within:border-ring", empty ? EMPTY : SET)} title={title} data-task-peek-chip={field} data-empty={empty || undefined}>
      {children}
    </label>
  );
}

/**
 * Due: a press opens the browser's date picker, and a date picked there (or the picker's Clear)
 * saves at once. A date typed from the keyboard saves on blur or Enter, as the task page's field
 * does, so the half-typed years a date input passes through are never written.
 */
function DueChip({ value, onSave }: { value: string | null; onSave(dueDate: string | null): unknown }) {
  const { draft, setDraft, commit } = useSavedDraft({ shown: value ?? "", accept: isSaveableDate, onSave: (v) => onSave(v || null) });
  const picking = useRef(false);
  const view = dueView(draft || null, localYmd());
  return (
    <Chip field="due" title={peekChipTitle("Due date", draft || null)} empty={!draft}>
      {draft ? <TaskDueLabel dueDate={draft} className="text-[length:inherit]" /> : <><Calendar className="size-3.5" aria-hidden />Due</>}
      <input type="date" aria-label="Due date" title={view ? `Due ${draft}` : "Add due date"} value={draft} className={OVERLAY}
        onClick={(e) => {
          const input = e.currentTarget as HTMLInputElement & { showPicker?(): void };
          try { input.showPicker?.(); picking.current = true; } catch { /* not allowed here: the field still takes typing */ }
        }}
        onKeyDown={(e) => {
          picking.current = false;
          if (e.key === "Enter") e.currentTarget.blur();
        }}
        onChange={(e) => {
          setDraft(e.target.value);
          // Picked rather than typed: leave the field, which saves it.
          if (picking.current) { picking.current = false; const input = e.currentTarget; setTimeout(() => input.blur(), 0); }
        }}
        onBlur={() => { picking.current = false; commit(); }} />
    </Chip>
  );
}

/** The next step as a draft that saves when left or removed (`useSavedDraft`). */
export function TaskNextStepField({ value, onSave, autoFocus, onDone }: {
  value: string | null; onSave(nextStep: string | null): unknown;
  /** Takes the cursor when shown (the quick view's folded next step was pressed). */
  autoFocus?: boolean;
  /** Called once the field is left, after it saved. */
  onDone?(): void;
}) {
  const { draft, setDraft, commit } = useSavedDraft({ shown: value ?? "", normalize: (v) => v.trim(), onSave: (v) => onSave(v || null) });
  return (
    <TaskProp label="Next step">
      <textarea aria-label="Next step" rows={autoFocus ? 3 : 2} maxLength={PPM_TASK_LIMITS.nextStep} value={draft} placeholder="What happens next"
        autoFocus={autoFocus} onFocus={autoFocus ? (e) => e.currentTarget.setSelectionRange(e.currentTarget.value.length, e.currentTarget.value.length) : undefined}
        onChange={(e) => setDraft(e.target.value)} onBlur={() => { commit(); onDone?.(); }}
        className="block w-full resize-y rounded-md border border-border-soft bg-surface px-1.5 py-1 text-[13px] leading-snug text-text outline-none placeholder:text-text-3 focus:border-ring" />
    </TaskProp>
  );
}

/**
 * The next step folded to two lines; a press unfolds it into the field, and leaving the field
 * folds it again. What was just typed shows folded until the saved task comes back with it.
 */
function TaskNextStepPeek({ value, onSave }: { value: string | null; onSave(nextStep: string | null): unknown }) {
  const [editing, setEditing] = useState(false);
  const [sent, setSent] = useState<string | null | undefined>(undefined);
  useEffect(() => setSent(undefined), [value]);
  // A save that did not land (`null`) shows the stored text again rather than the unsaved one.
  const save = (v: string | null) => {
    setSent(v);
    return Promise.resolve(onSave(v)).then((answer) => { if (answer === null) setSent(undefined); return answer; });
  };
  if (editing) return <TaskNextStepField value={value} onSave={save} autoFocus onDone={() => setEditing(false)} />;
  const text = sent !== undefined ? sent : value;
  return (
    <button type="button" onClick={() => setEditing(true)} aria-label={text ? `Next step: ${text}` : "Add the next step"} data-task-peek-next-step=""
      className="-mx-1.5 block min-h-0! w-[calc(100%+12px)] rounded-md px-1.5 py-1 text-left can-hover:hover:bg-surface-hover">
      <span className="block text-[11.5px] font-medium text-text-3">Next step</span>
      {text
        ? <span className="line-clamp-2 text-[13px] leading-snug text-text [overflow-wrap:anywhere]" data-task-peek-next-step-text="">{text}</span>
        : <span className="block text-[13px] leading-snug text-text-3">What happens next</span>}
    </button>
  );
}

export function TaskPeekFields({ task, settings, onPatch, onStatus, className }: {
  task: TaskDto; settings: TaskProjectSettings | null; onPatch(patch: TaskPatch): unknown; onStatus(statusId: string): void; className?: string;
}) {
  const people = taskPeople(task, settings?.members);
  const assignee = peekMemberName(task.assigneeMemberId, people);
  const waiting = peekMemberName(task.waitingOnMemberId, people);
  const urgency = URGENCY_LABEL[task.effectiveUrgency];
  const urgencyTitle = task.urgencyRaised
    ? `Urgency: ${urgency} (raised from ${URGENCY_LABEL[task.urgency]} by the due date)`
    : peekChipTitle("Urgency", urgency);
  const statusOf = (id: string) => settings?.statuses.find((s) => s.id === id);
  const member = (c: TaskChoice) => (c.value
    ? <TaskMemberAvatar name={c.label} memberId={c.value} size="sm" showName className="text-[length:inherit]" />
    : <span className="text-text-3">Nobody</span>);
  return (
    <div className={cn("space-y-2.5 text-[13px] max-md:space-y-3 max-md:[&_textarea]:text-[15px]", className)} data-task-peek-fields="">
      <div className="flex flex-wrap gap-1.5 max-md:gap-x-2 max-md:gap-y-3" data-task-peek-chips="">
        <MenuChip field="status" label="Status" value={task.statusId} title={peekChipTitle("Status", task.statusName)}
          choices={statusChoices(task, settings?.statuses)} onChange={onStatus}
          renderChoice={(c) => {
            const s = statusOf(c.value);
            return s ? <TaskStatusGlyph baseGroup={s.baseGroup} closedAs={s.closedAs} name={c.label} showName className="text-[length:inherit] text-text" /> : c.label;
          }}>
          <TaskStatusGlyph baseGroup={task.baseGroup} closedAs={task.closedAs} name={task.statusName} showName className="min-w-0 text-[length:inherit] text-text" />
        </MenuChip>
        <MenuChip field="urgency" label="Urgency" value={task.urgency} title={urgencyTitle}
          choices={urgencyChoices(task)} onChange={(v) => onPatch({ urgency: v as Urgency })}
          renderChoice={(c) => <span className="font-medium" style={{ color: URGENCY_TONE[c.value as Urgency] }}>{c.label}</span>}>
          <span className="inline-flex items-center gap-1 font-medium" style={{ color: URGENCY_TONE[task.effectiveUrgency] }} data-urgency={task.effectiveUrgency}>
            <Clock className="size-3.5" aria-hidden />{urgency}
            {task.urgencyRaised && <span className="rounded bg-accent-wash px-1 text-[10px] font-normal text-primary">auto</span>}
          </span>
        </MenuChip>
        <MenuChip field="importance" label="Importance" value={task.importance} title={peekChipTitle("Importance", IMPORTANCE_LABEL[task.importance])}
          choices={importanceChoices()} onChange={(v) => onPatch({ importance: v as Importance })}
          renderChoice={(c) => <TaskImportanceBars importance={c.value as Importance} className="text-[length:inherit]" />}>
          <TaskImportanceBars importance={task.importance} className="text-[length:inherit]" />
        </MenuChip>
        <MenuChip field="assignee" label="Assignee" value={task.assigneeMemberId ?? ""} title={peekChipTitle("Assignee", assignee)} empty={!assignee}
          choices={memberChoices(people)} onChange={(v) => onPatch({ assigneeMemberId: v || null })} renderChoice={member}>
          {assignee
            ? <TaskMemberAvatar name={assignee} memberId={task.assigneeMemberId} size="sm" showName className="min-w-0 max-w-[10rem] text-[length:inherit]" />
            : <><UserPlus className="size-3.5" aria-hidden />Assignee</>}
        </MenuChip>
        <MenuChip field="waiting" label="Waiting on" value={task.waitingOnMemberId ?? ""} title={peekChipTitle("Waiting on", waiting)} empty={!waiting}
          choices={memberChoices(people)} onChange={(v) => onPatch({ waitingOnMemberId: v || null })} renderChoice={member}>
          <Hand className="size-3.5 shrink-0 text-warning" aria-hidden />
          {waiting ? <span className="min-w-0 max-w-[10rem] truncate">{waiting}</span> : "Waiting on"}
        </MenuChip>
        <DueChip value={task.dueDate} onSave={(dueDate) => onPatch({ dueDate })} />
      </div>
      <TaskNextStepPeek value={task.nextStep} onSave={(nextStep) => onPatch({ nextStep })} />
    </div>
  );
}
