/**
 * The morning digest PPM put together: one section per project that was asked, its manager's items
 * numbered, or why there are none. Every item is a manager AI's words and is drawn as plain text.
 */
import { Coffee } from "@/lib/icons";
import { cn } from "@/lib/utils";
import type { AssistantCard } from "../../../../shared/assistant-cards";
import { DIGEST_NO_ANSWER, DIGEST_NOTHING_NEW, type DigestProject } from "../../../../shared/assistant-digest";
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
    </section>
  );
}

export function DigestCard({ card }: { card: AssistantCard }) {
  // A digest from before PPM put them together was one manager's list.
  const projects: DigestProject[] = card.payload.projects
    ?? [{ name: card.projectName ?? "project", state: "answered", items: card.payload.items ?? [] }];
  const items = projects.reduce((n, p) => n + p.items.length, 0);
  return (
    <CardShell
      card={card}
      look={{ label: "Morning digest", Icon: Coffee, tone: "digest" }}
      meta={`${plural(projects.length, "project")}, ${plural(items, "item")}`}
    >
      <div className="space-y-2">
        {projects.map((p, i) => <ProjectSection key={`${i}:${p.name}`} project={p} />)}
      </div>
    </CardShell>
  );
}
