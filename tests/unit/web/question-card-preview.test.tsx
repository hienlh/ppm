import { describe, expect, it } from "bun:test";
import { QuestionCard } from "../../../src/web/components/chat/question-card.tsx";
import { hasOptionPreviews, previewOptionIndex } from "../../../src/web/components/chat/question-option-preview.tsx";
import { mount, click } from "../../helpers/react-dom.tsx";

const options = [
  { label: "Go", preview: "1. build\n2. ship" },
  { label: "Change", preview: "Tell me what to change" },
  { label: "Later" },
];
const questions = [{ question: "Start?", options }];

const pane = (container: HTMLElement) => container.querySelector("[data-testid=question-option-preview]");
const option = (container: HTMLElement, label: string) => Array.from(container.querySelectorAll("[role=button]"))
  .find((element) => element.textContent?.includes(label)) ?? null;

describe("question option preview", () => {
  it("exists only when some option carries a preview", () => {
    expect(hasOptionPreviews(options)).toBe(true);
    expect(hasOptionPreviews([{ label: "A" }, { label: "B", preview: "  " }])).toBe(false);
  });

  it("describes the focused option, and the selection while Other is focused", () => {
    expect(previewOptionIndex(options, 1, [])).toBe(1);
    expect(previewOptionIndex(options, 3, ["Change"])).toBe(1);
    expect(previewOptionIndex(options, 3, [])).toBe(-1);
  });

  it("shows the first option's preview at once and follows the option the user picks", async () => {
    const view = await mount(<QuestionCard questions={questions} autoFocus={false} onSubmit={() => {}} onSkip={() => {}} />);
    try {
      expect(pane(view.container)?.textContent).toContain("1. build\n2. ship");
      await click(option(view.container, "Change"));
      expect(pane(view.container)?.textContent).toContain("Tell me what to change");
      await click(option(view.container, "Later"));
      expect(pane(view.container)?.textContent).toContain("No preview for this option.");
    } finally { await view.unmount(); }
  });

  it("renders no pane for a question without previews", async () => {
    const view = await mount(<QuestionCard questions={[{ question: "Q", options: [{ label: "A" }] }]} autoFocus={false}
      onSubmit={() => {}} onSkip={() => {}} />);
    try { expect(pane(view.container)).toBeNull(); } finally { await view.unmount(); }
  });
});
