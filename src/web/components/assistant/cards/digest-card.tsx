/**
 * The morning digest PPM put together: one section per project that was asked, its manager's items
 * numbered, or why there are none, then the project's waiting tasks as PPM read them from its task
 * store (on whom, until when; the user's own first and marked). Every item is a manager AI's words
 * and is drawn as plain text.
 */
import { Coffee, Hand } from "@/lib/icons";
import { cn } from "@/lib/utils";
import type { AssistantCard } from "../../../../shared/assistant-cards";
import {
  DIGEST_NO_ANSWER, DIGEST_NOTHING_NEW, DIGEST_RESURFACED_HEADING, DIGEST_VOICE_LEARNED_HINT, digestVoiceLearnedHeading,
  digestWaitingSummary, type DigestProject, type DigestResurfacedTask, type DigestVoiceLearned,
} from "../../../../shared/assistant-digest";
import { CardShell } from "./card-shell";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function ProjectSection({ project }: { project: DigestProject }) {
  const answered = project.state === "answered";
  return (
    <section className="border-t border-border pt-2 first:border-t-0 first:pt-0" data-digest-project={project.name}>
      <h4 className="mb-1 flex items-center gap-1.5 text-[13px] font-semibold">
        <span
          aria-hidden
          className={cn("size-2 shrink-0 rounded-full", !answered ? "bg-text-subtle" : project.items.length ? "bg-primary" : "bg-success")}
        />
        <span className="min-w-0 truncate">{project.name}</span>
      </h4>
      {!answered && <p className="text-[13px] italic text-text-subtle">{DIGEST_NO_ANSWER}</p>}
      {answered && project.items.length === 0 && <p className="text-[13px] text-text-secondary">{DIGEST_NOTHING_NEW}</p>}
      {answered && project.items.length > 0 && (
        <ol className="list-decimal space-y-0.5 pl-5 text-[13px] leading-relaxed">
          {project.items.map((item, i) => <li key={`${i}:${item}`} className="break-words">{item}</li>)}
        </ol>
      )}
      {!!project.waiting?.length && <WaitingTasks project={project} />}
    </section>
  );
}

/** The project's waiting tasks, PPM's own list: code, title, on whom and until when. */
function WaitingTasks({ project }: { project: DigestProject }) {
  const more = project.waitingMore ?? 0;
  return (
    <div className="mt-1.5" data-digest-waiting="">
      <p className="text-[12px] font-medium text-text-secondary">{digestWaitingSummary(project)}<span className="font-normal text-text-subtle"> · from Tasks</span></p>
      <ul className="mt-0.5 space-y-0.5 text-[12.5px]">
        {project.waiting!.map((w) => (
          <li key={w.ref} className="flex min-w-0 items-center gap-1.5" data-digest-waiting-task={w.ref} data-digest-waiting-mine={w.mine ? "" : undefined}>
            <span className="shrink-0 font-mono text-[11.5px] text-text-subtle">{w.ref}</span>
            <span className="min-w-0 flex-1 truncate" title={w.title}>{w.title}</span>
            <span className={cn("inline-flex min-w-0 max-w-[60%] shrink-0 items-center gap-1 whitespace-nowrap", w.mine ? "font-medium text-primary" : "text-warning")}
              title={w.until ? `${w.label} · ${w.until}` : w.label}>
              {w.mine && <Hand aria-hidden className="size-3 shrink-0" />}
              <span className="min-w-0 truncate">{w.label}</span>
              {w.until && <span className="shrink-0 text-text-subtle">· {w.until}</span>}
            </span>
          </li>
        ))}
        {more > 0 && <li className="text-text-subtle">and {more} more in Tasks</li>}
      </ul>
    </div>
  );
}

/** PPM's own section: the tasks back from a snooze that day, by code and title. */
function ResurfacedSection({ tasks }: { tasks: readonly DigestResurfacedTask[] }) {
  return (
    <section className="border-b border-border pb-2" data-digest-resurfaced="">
      <h4 className="mb-1 flex items-center gap-1.5 text-[13px] font-semibold">
        <span aria-hidden className="size-2 shrink-0 rounded-full bg-warning" />
        {DIGEST_RESURFACED_HEADING}
      </h4>
      <ul className="space-y-0.5 text-[13px] leading-relaxed">
        {tasks.map((t) => (
          <li key={t.ref} className="flex min-w-0 gap-1.5">
            <span className="shrink-0 font-mono text-[12px] text-text-secondary">{t.ref}</span>
            <span className="min-w-0 break-words">{t.title}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Monday's voice section: the words learned this week, to know about (undo lives in Settings → Voice). */
function VoiceLearnedSection({ words }: { words: readonly DigestVoiceLearned[] }) {
  return (
    <section className="border-t border-border pt-2" data-digest-voice-learned="">
      <h4 className="mb-1 flex items-center gap-1.5 text-[13px] font-semibold">
        <span aria-hidden className="size-2 shrink-0 rounded-full bg-primary" />
        {digestVoiceLearnedHeading(words.length)}
      </h4>
      <p className="text-[13px] leading-relaxed">
        {words.map((w, i) => (
          <span key={`${w.project}:${w.word}`}>
            {i > 0 && <span className="text-text-subtle"> · </span>}
            <span className="font-medium">{w.word}</span>
            <span className="text-text-secondary"> ({w.from})</span>
          </span>
        ))}
      </p>
      <p className="mt-1 text-xs text-text-subtle">{DIGEST_VOICE_LEARNED_HINT}</p>
    </section>
  );
}

/** A digest's sections; one from before PPM put them together was one manager's list. */
export function digestProjects(card: AssistantCard): DigestProject[] {
  return card.payload.projects
    ?? [{ name: card.projectName ?? "project", state: "answered", items: card.payload.items ?? [] }];
}

/** "3 projects, 4 items". */
export function digestSummary(projects: readonly DigestProject[]): string {
  const items = projects.reduce((n, p) => n + p.items.length, 0);
  return `${plural(projects.length, "project")}, ${plural(items, "item")}`;
}

export function DigestCard({ card }: { card: AssistantCard }) {
  const projects = digestProjects(card);
  return (
    <CardShell
      card={card}
      look={{ label: "Morning digest", Icon: Coffee, tone: "digest" }}
      meta={digestSummary(projects)}
    >
      <div className="space-y-2">
        {!!card.payload.resurfaced?.length && <ResurfacedSection tasks={card.payload.resurfaced} />}
        {projects.map((p, i) => <ProjectSection key={`${i}:${p.name}`} project={p} />)}
        {!!card.payload.voiceLearned?.length && <VoiceLearnedSection words={card.payload.voiceLearned} />}
      </div>
    </CardShell>
  );
}
